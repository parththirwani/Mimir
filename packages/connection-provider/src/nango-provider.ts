import { Nango } from "@nangohq/node";
import { ConnectionError, NotConfiguredError, ProviderError } from "./types.js";
import type { ConnectionErrorKind, ConnectionProvider, GmailRequestOptions, GmailRequestResult, IntegrationConnectionStore } from "./types.js";

// Nango's provider config key for the Gmail API is `google-mail` (the id the
// account owner set up in Nango). If the Nango integration is ever renamed,
// this is the one place to update it.
export const GMAIL_INTEGRATION = "google-mail";

const GMAIL_API = "https://gmail.googleapis.com";

export interface NangoProviderOptions {
  secretKey?: string;
  host?: string;
  store: IntegrationConnectionStore;
  // Which Nango integration this provider drives. Defaults to Gmail; pass
  // NOTION_INTEGRATION etc. to reuse the same ConnectionProvider for other
  // integrations. Also feeds the local IntegrationConnection.provider row.
  providerKey?: string;
  // OAuth user_scopes requested at connect time (Nango's integrations_config_defaults).
  connectScopes?: string;
}

export class NangoConnectionProvider implements ConnectionProvider {
  private readonly secretKey?: string;
  private readonly host?: string;
  private readonly store: IntegrationConnectionStore;
  private readonly providerKey: string;
  private readonly connectScopes?: string;
  private client?: Nango;

  constructor(opts: NangoProviderOptions) {
    this.secretKey = opts.secretKey;
    this.host = opts.host;
    this.store = opts.store;
    this.providerKey = opts.providerKey ?? GMAIL_INTEGRATION;
    this.connectScopes = opts.connectScopes;
  }

  private nango(): Nango {
    if (!this.secretKey) throw new NotConfiguredError("NANGO_SECRET_KEY is not configured");
    this.client ??= new Nango({ secretKey: this.secretKey, host: this.host });
    return this.client;
  }

  // The Connect UI (opened in-page from the session token) has no success
  // redirect, so `authorizationUrl` is unused by the app now; kept for the
  // callback fallback route. `sessionToken` feeds @nangohq/frontend's openConnectUI.
  async initiateOAuth(userId: string): Promise<{ sessionToken: string; authorizationUrl: string }> {
    const scopes = this.connectScopes ?? "gmail.compose gmail.readonly";
    // Only send per-connect user_scopes when a provider supplies them. An empty
    // connectScopes (e.g. Notion, whose scopes are app-level, not per-user) means
    // "use Nango's configured defaults" — sending an empty string would override
    // them, so the defaults block is omitted for that case.
    const defaults =
      this.connectScopes === undefined || this.connectScopes === "" ? undefined : { [this.providerKey]: { user_scopes: scopes } };
    const { data } = await this.nango().createConnectSession({
      tags: { end_user_id: userId },
      allowed_integrations: [this.providerKey],
      ...(defaults ? { integrations_config_defaults: defaults } : {}),
    });
    return { sessionToken: data.token, authorizationUrl: data.connect_link };
  }

  // Callback fires right after OAuth — no local row yet, so the Nango connection
  // is located by the end_user_id tag the connect session stamped on it. The SDK's
  // `userId` param filters Nango's end_user field (which the connect session does
  // not set), so the tag filter is required to match.
  async handleCallback(userId: string): Promise<void> {
    const connectionId = await this.findConnectionByTag(userId);
    if (!connectionId) throw new ConnectionError("not_connected", `no ${this.providerKey} connection found for user`);
    await this.upsertConnection(userId, connectionId, "connected");
  }

  // Reconciliation backstop: Nango's Connect UI has no success redirect, so the
  // local row may be missing even though a connection exists. If a local row is
  // already present it's left as-is (no Nango call). Pass connectionId to skip
  // the tag lookup (the auth-webhook path); omit it to heal by tag (status probe).
  async syncConnection(userId: string, connectionId?: string): Promise<boolean> {
    if (await this.findConnectionId(userId)) return true;
    const nangoConnectionId = connectionId ?? (await this.findConnectionByTag(userId));
    if (!nangoConnectionId) return false;
    await this.upsertConnection(userId, nangoConnectionId, "connected");
    return true;
  }

  private async findConnectionByTag(userId: string): Promise<string | null> {
    const { connections } = await this.nango().listConnections({
      tags: { end_user_id: userId },
      integrationId: this.providerKey,
    });
    return connections[0]?.connection_id ?? null;
  }

  async getConnection(userId: string): Promise<{ status: string } | null> {
    const row = await this.store.findFirst({ where: { userId, provider: this.providerKey } });
    return row ? { status: row.status } : null;
  }

  // No token caching — Nango refreshes on fetch, and recommends <=5min freshness.
  async getAccessToken(userId: string): Promise<string> {
    const connectionId = await this.findConnectionId(userId);
    if (!connectionId) throw new ConnectionError("not_connected", `no ${this.providerKey} connection for user`);
    let conn;
    try {
      conn = await this.nango().getConnection(this.providerKey, connectionId);
    } catch (e) {
      const kind = this.nangoErrorKind(e);
      if (kind) throw new ConnectionError(kind, String((e as Error)?.message ?? e));
      throw e;
    }
    if (conn.credentials.type !== "OAUTH2" || !conn.credentials.access_token) {
      throw new ProviderError("malformed_response", "nango connection has no access_token");
    }
    return conn.credentials.access_token;
  }

  // Mirror of Composio's gmailRequest so the shared Gmail transport works on the
  // Nango rollback path too: resolve the raw token, then hit gmail.googleapis.com
  // directly. Same { status, data } contract, same upstream error mapping upstream
  // (gmail.ts), so switching back to Nango requires no Gmail-layer changes.
  async gmailRequest(userId: string, path: string, opts: GmailRequestOptions = {}): Promise<GmailRequestResult> {
    const connectionId = await this.findConnectionId(userId);
    if (!connectionId) throw new ConnectionError("not_connected", `no ${this.providerKey} connection for user`);
    const token = await this.getAccessToken(userId);
    const { method = "GET", body } = opts;
    const res = await fetch(`${GMAIL_API}${path}${buildQuery(opts.query)}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: unknown;
    try {
      data = res.status === 204 ? undefined : await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  }

  async revoke(userId: string): Promise<void> {
    const row = await this.store.findFirst({ where: { userId, provider: this.providerKey } });
    if (!row) return;
    try {
      await this.nango().deleteConnection(this.providerKey, row.connectionId);
    } catch {
      // Local row is still removed so the UI flips to disconnected even if the
      // upstream connection is already gone.
    }
    await this.store.delete({ where: { id: row.id } });
  }

  private async findConnectionId(userId: string): Promise<string | null> {
    const row = await this.store.findFirst({ where: { userId, provider: this.providerKey } });
    return row?.connectionId ?? null;
  }

  private async upsertConnection(userId: string, nangoConnectionId: string, status: string): Promise<void> {
    const existing = await this.store.findFirst({ where: { userId, provider: this.providerKey } });
    if (existing) await this.store.update({ where: { id: existing.id }, data: { connectionId: nangoConnectionId, status } });
    else await this.store.create({ data: { userId, provider: this.providerKey, connectionId: nangoConnectionId, status } });
  }

  private nangoErrorKind(e: unknown): ConnectionErrorKind | null {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return "not_connected";
    if (status === 400 || status === 401 || status === 403) return "expired";
    if (String((e as Error)?.message ?? "").includes("invalid_credentials")) return "expired";
    return null;
  }
}

// `?maxResults=10&metadataHeaders=From&metadataHeaders=Subject` — arrays render
// as repeated keys, matching what the Composio proxy parameters array expresses.
function buildQuery(query?: Record<string, string | number | string[]>): string {
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(query ?? {})) {
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
