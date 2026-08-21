import { Composio } from "@composio/core";
import { ConnectionError, NotConfiguredError } from "./types.js";
import type {
  ConnectionProvider,
  ConnectionErrorKind,
  GmailRequestOptions,
  GmailRequestResult,
  IntegrationConnectionStore,
} from "./types.js";
import { GMAIL_INTEGRATION } from "./nango-provider.js";

// Composio is the primary Gmail connection provider (no connection caps — it's
// metered on tool calls instead).
//
// Composio redacts connected-account secrets (`access_token`, `refresh_token`,
// ...) on EVERY read endpoint — there is no unmasked variant of
// `connectedAccounts.get()`. So this provider never touches a raw token. Every
// Gmail API call goes through `composio.tools.proxyExecute()`, which injects the
// connected account's credentials server-side and returns `{ status, data }`.
const COMPOSIO_DEFAULT_BASE_URL = "https://backend.composio.dev";

export interface ComposioProviderOptions {
  apiKey?: string;
  // Overrides the default Composio cloud base URL (self-hosted / region pin).
  baseUrl?: string;
  // The Composio auth config that drives the Gmail toolkit (managed or custom).
  // Required to create a connect link; absent => the factory refuses Composio.
  authConfigId?: string;
  // Web URL browsers land on after composing the OAuth (`initialize` a
  // session-less link is not enough; the callback carries connected_account_id).
  callbackUrl?: string;
  store: IntegrationConnectionStore;
}

export class ComposioConnectionProvider implements ConnectionProvider {
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly authConfigId?: string;
  private readonly callbackUrl?: string;
  private readonly store: IntegrationConnectionStore;
  private client?: Composio;

  constructor(opts: ComposioProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.authConfigId = opts.authConfigId;
    this.callbackUrl = opts.callbackUrl;
    this.store = opts.store;
  }

  private composio(): Composio {
    if (!this.apiKey) throw new NotConfiguredError("COMPOSIO_API_KEY is not configured");
    if (!this.authConfigId) throw new NotConfiguredError("COMPOSIO_GMAIL_AUTH_CONFIG is not configured");
    this.client ??= new Composio({ apiKey: this.apiKey, baseURL: this.baseUrl ?? COMPOSIO_DEFAULT_BASE_URL });
    return this.client;
  }

  // Composio link = a browser redirect (no in-page SDK widget like Nango's).
  // `sessionToken` is the connect request id (unused by the frontend now);
  // `authorizationUrl` is the OAuth URL we redirect the user to.
  async initiateOAuth(userId: string): Promise<{ sessionToken: string; authorizationUrl: string }> {
    const connectionRequest = await this.composio().connectedAccounts.link(userId, this.authConfigId!, {
      ...(this.callbackUrl ? { callbackUrl: this.callbackUrl } : {}),
    });
    return { sessionToken: connectionRequest.id, authorizationUrl: connectionRequest.redirectUrl ?? "" };
  }

  // Composio's callback carries ?status=success&connected_account_id=ca_x, so
  // the route passes `connectionId` through. When absent (a direct manual call),
  // fall back to the user's most recent gmail connected account.
  async handleCallback(userId: string, connectionId?: string): Promise<void> {
    const id = connectionId ?? (await this.findComposioConnectionId(userId));
    if (!id) throw new ConnectionError("not_connected", "no gmail connected account for user");
    await this.upsertConnection(userId, id, "connected");
  }

  // Reconciliation backstop: heal a missing OR stale local row from Composio by
  // the user's gmail connected account. Unlike the Nango mirror, always re-check
  // Composio — the worker flips the row to "expired" on a transient token error
  // (fail-fast reconnect UX), and if Composio still has the account ACTIVE that
  // row must be healed back, or the UI shows a bogus "connect" state forever.
  async syncConnection(userId: string, connectionId?: string): Promise<boolean> {
    const id = connectionId ?? (await this.findComposioConnectionId(userId));
    if (!id) return false;
    // Heal only when the account actually yields a working connection. The
    // account can stay listed ACTIVE while its token is dead (revoked), and
    // healing then fights the worker's fail-fast "expired" flip forever. Probes
    // with the same proxyExecute transport the data path uses — one failure
    // mode, no separate health-check code to diverge.
    try {
      const { status } = await this.gmailRequest(userId, "/gmail/v1/users/me/profile", { connectionId: id });
      if (status !== 200) {
        // A probe that finds the account dead must persist the truth — otherwise
        // the local row stays "connected" while the upstream token is revoked.
        await this.upsertConnection(userId, id, "expired");
        return false;
      }
    } catch {
      await this.upsertConnection(userId, id, "expired");
      return false;
    }
    await this.upsertConnection(userId, id, "connected");
    return true;
  }

  async getConnection(userId: string): Promise<{ status: string } | null> {
    const row = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    return row ? { status: row.status } : null;
  }

  // The single Gmail transport: composite the request to Composio's proxy
  // endpoint, which injects the connected account's credentials server-side and
  // returns the upstream HTTP status + body. Raw tokens never touch this app.
  async gmailRequest(userId: string, path: string, opts: GmailRequestOptions = {}): Promise<GmailRequestResult> {
    const connectionId = opts.connectionId ?? (await this.findConnectionId(userId));
    if (!connectionId) throw new ConnectionError("not_connected", "no gmail connection for user");
    const { method = "GET", body } = opts;
    const parameters = queryToProxyParameters(opts.query);
    try {
      const res = (await this.composio().tools.proxyExecute({
        endpoint: path,
        method,
        body,
        parameters,
        connectedAccountId: connectionId,
      } as never)) as { status: number; data: unknown };
      return { status: res.status, data: res.data };
    } catch (e) {
      const kind = this.composioErrorKind(e);
      if (kind) throw new ConnectionError(kind, String((e as Error)?.message ?? e));
      throw e;
    }
  }

  async revoke(userId: string): Promise<void> {
    const row = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    if (!row) return;
    try {
      await this.composio().connectedAccounts.delete(row.connectionId as never);
    } catch {
      // Local row is still removed so the UI flips to disconnected even if the
      // upstream connected account is already gone.
    }
    await this.store.delete({ where: { id: row.id } });
  }

  private async findConnectionId(userId: string): Promise<string | null> {
    const row = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    return row?.connectionId ?? null;
  }

  private async findComposioConnectionId(userId: string): Promise<string | null> {
    const { items } = await this.composio().connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: ["gmail"],
      statuses: ["ACTIVE"],
    });
    return items[0]?.id ?? null;
  }

  private async upsertConnection(userId: string, connectionId: string, status: string): Promise<void> {
    const existing = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    if (existing) await this.store.update({ where: { id: existing.id }, data: { connectionId, status } });
    else await this.store.create({ data: { userId, provider: GMAIL_INTEGRATION, connectionId, status } });
  }

  // The @composio client (stainless codegen) throws its APIError subclasses on
  // any non-2xx with `status` on the TOP level (not axios's response.status). A
  // proxied call can fail at the Composio layer (deleted/403 access) and needs
  // the same mapping the data path's status check applies to upstream errors.
  private composioErrorKind(e: unknown): ConnectionErrorKind | null {
    const status = (e as { status?: number })?.status ?? (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 400) return "not_connected";
    if (status === 401 || status === 403) return "expired";
    const code = (e as { code?: string })?.code;
    if (code === "EXIT_CODE_429" || code === "RATE_LIMITED") return "expired";
    if (isComposioAuthStateError(e)) return "expired";
    return null;
  }
}

// Composio encodes a dead connected account as a nested auth-state error (slug
// TOOL_AUTH_BadConnectedAccountState, e.g. an account whose OAuth grant was
// revoked — "invalid_grant"). Its HTTP status (422) is not itself a signal, so
// fingerprint the nested payload the way the status-code checks above do. A
// revoked/expired token can NEVER self-heal, so this must be fail-fast
// (ConnectionError("expired")), never a silent generic error.
function isComposioAuthStateError(e: unknown): boolean {
  const text = `${(e as Error)?.message ?? ""}\n${JSON.stringify(e)}`;
  return (
    /TOOL_AUTH_/.test(text) ||
    /not in an ACTIVE state/i.test(text) ||
    /invalid_grant/i.test(text) ||
    /expired or revoked/i.test(text)
  );
}

// Expand `{ name: "a" | "a", "b": ["x","y"] }` into proxy parameters, rendering
// arrays as repeated keys (Gmail's `metadataHeaders=From&metadataHeaders=Subject`).
function queryToProxyParameters(query?: Record<string, string | number | string[]>): { in: "query"; name: string; value: string }[] {
  const parameters: { in: "query"; name: string; value: string }[] = [];
  for (const [name, raw] of Object.entries(query ?? {})) {
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      parameters.push({ in: "query", name, value: String(v) });
    }
  }
  return parameters;
}