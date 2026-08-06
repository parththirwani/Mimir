import { Composio } from "@composio/core";
import { ConnectionError, ProviderError, NotConfiguredError } from "./types.js";
import type { ConnectionProvider, ConnectionErrorKind, IntegrationConnectionStore } from "./types.js";
import { GMAIL_INTEGRATION } from "./nango-provider.js";

// Composio is the primary Gmail connection provider (no connection caps — it's
// metered on tool calls instead). Unlike Nango, which hides OAuth behind an
// in-page connect UI and returns a raw token on demand, Composio is a
// tool-execution platform. This provider reaches INTO the connected account's
// `state` for a raw Google OAuth access token so the existing Gmail REST code
// (reads/drafts/send against gmail.googleapis.com) keeps working untouched.
//
// ponytail: the token lives at `connectedAccount.state.val.access_token`, which
// the SDK documents (`state` is the first-class credential field; `data`/`params`
// are the deprecated legacy fields). It's still a reach-into-the-record, so
// getAccessToken validates the exact shape at runtime and throws loudly if
// Composio ever moves it — fail fast into the existing error path + canary,
// never a silent undefined that breaks sends days later.
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

  // Reconciliation backstop: heal a missing local row from Composio by the
  // user's gmail connected account. Mirrors Nango's syncConnection.
  async syncConnection(userId: string, connectionId?: string): Promise<boolean> {
    if (await this.findConnectionId(userId)) return true;
    const id = connectionId ?? (await this.findComposioConnectionId(userId));
    if (!id) return false;
    await this.upsertConnection(userId, id, "connected");
    return true;
  }

  async getConnection(userId: string): Promise<{ status: string } | null> {
    const row = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    return row ? { status: row.status } : null;
  }

  // Raw Google access token for gmail.googleapis.com. Shape-checked at runtime
  // and throws loudly if Composio's record shape drifts (see header note).
  async getAccessToken(userId: string): Promise<string> {
    const connectionId = await this.findConnectionId(userId);
    if (!connectionId) throw new ConnectionError("not_connected", "no gmail connection for user");
    let account: { state?: unknown };
    try {
      account = await this.composio().connectedAccounts.get(connectionId as never);
    } catch (e) {
      const kind = this.composioErrorKind(e);
      if (kind) throw new ConnectionError(kind, String((e as Error)?.message ?? e));
      throw e;
    }
    const token = this.extractAccessToken(account.state);
    return token;
  }

  async revoke(userId: string): Promise<void> {
    const row = await this.store.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
    if (!row) return;
    try {
      await this.composio().connectedAccounts.delete(row.connectionId as never);
    } catch {
      // ponytail: best-effort — the local row is still removed so the UI flips to
      // disconnected even if Composio's connected account is already gone.
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

  // The landmine guardrail: `state` is documented as the credential field, but
  // reaching the token requires walking OAuth2 -> ACTIVE -> access_token. If any
  // step isn't exactly where expected, throw loudly instead of returning
  // undefined — the canary job and the worker's fail-fast both surface this.
  private extractAccessToken(state: unknown): string {
    const s = state as { authScheme?: string; val?: unknown } | null | undefined;
    if (!s || s.authScheme !== "OAUTH2") {
      throw new ProviderError("malformed_response", "composio gmail connection has unexpected auth state");
    }
    const val = s.val as { status?: string; access_token?: unknown } | null | undefined;
    if (!val || val.status !== "ACTIVE" || typeof val.access_token !== "string") {
      throw new ProviderError("malformed_response", "composio gmail connection has no ACTIVE access_token");
    }
    return val.access_token;
  }

  private composioErrorKind(e: unknown): ConnectionErrorKind | null {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 400) return "not_connected";
    if (status === 401) return "expired";
    const code = (e as { code?: string })?.code;
    if (code === "EXIT_CODE_429" || code === "RATE_LIMITED") return "expired";
    return null;
  }
}