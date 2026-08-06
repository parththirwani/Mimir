import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { GMAIL_INTEGRATION, NOTION_INTEGRATION, NangoConnectionProvider, LINEAR_INTEGRATION, VERCEL_INTEGRATION, INTERCOM_INTEGRATION, SENTRY_INTEGRATION, providerFor, gmailProvider } from "@mimir/connection-provider";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";

const cfg = getConfig();
const prisma = getPrismaClient();
const store = prisma.integrationConnection;
const gmailCallbackUrl = `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`;

// 5.7.3 — the managed-integration roster, all driven through the same
// ConnectionProvider abstraction. A settings page renders this list.
const ROSTER = [
  { key: GMAIL_INTEGRATION, label: "Gmail" },
  { key: NOTION_INTEGRATION, label: "Notion" },
  { key: LINEAR_INTEGRATION, label: "Linear" },
  { key: VERCEL_INTEGRATION, label: "Vercel" },
  { key: INTERCOM_INTEGRATION, label: "Intercom" },
  { key: SENTRY_INTEGRATION, label: "Sentry" },
];

// Nango-backed OAuth. Config-only values are injected from getConfig() — the
// provider package itself stays dependency-free.
function providerForKey(key: string): NangoConnectionProvider {
  return providerFor(key)({
    secretKey: cfg.NANGO_SECRET_KEY,
    host: cfg.NANGO_BASE_URL,
    store: prisma.integrationConnection,
  });
}

// Nango's API surfaces structured failures on createConnectSession (the Auth
// error payload is delivered in the Connect UI even when the server call 400s).
// Map the common ones to a status the server actually returns + a message the
// UI can show instead of a raw AxiosError. `resource_capped` is an account/hard
// connection limit, not a config bug — don't hide it behind "try again".
function mapConnectError(e: unknown): { status: number; code: string; message: string } {
  const data = (e as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } } })?.response?.data;
  const code = data?.error?.code;
  const raw = data?.error?.message;
  if (code === "resource_capped") {
    return {
      status: 429,
      code: "CONNECT_LIMIT",
      message: "This workspace has hit its connection limit. Disconnect an unused integration in Nango, or upgrade the plan.",
    };
  }
  return {
    status: 502,
    code: "CONNECT_FAILED",
    message: raw ? `Couldn't start the connect flow: ${raw}` : "Couldn't start the connect flow. Is Nango configured?",
  };
}

export const integrationsRouter: Router = Router();

// Dedicated Gmail routes FIRST — the generic /integrations/:providerKey routes
// below would otherwise shadow these (the roster uses key `google-mail`, while
// the chat UI calls `gmail`; a generic match would 404 "unknown integration").
// GET /api/v1/integrations/gmail/connect — initiate the OAuth flow. Nango
// returns a sessionToken for its in-page Connect UI; Composio returns an
// authorizationUrl to redirect the browser to. The UI picks whichever is present.
integrationsRouter.get("/integrations/gmail/connect", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  try {
    const { sessionToken, authorizationUrl } = await gmailProvider(cfg, store, gmailCallbackUrl).initiateOAuth(userId);
    res.json({ sessionToken, authorizationUrl });
  } catch (e) {
    getLogger().error({ err: e, userId, provider: "gmail" }, "gmail connect session failed");
    const err = mapConnectError(e);
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
});
// GET /api/v1/integrations/gmail/callback — the provider's OAuth success URL.
// Session cookie rides the same browser so req.userId is available. Composio
// appends ?status=success&connected_account_id=ca_x; forwarded to handleCallback.
// Always redirect back to the app; a failed upsert is logged, not fatal.
integrationsRouter.get("/integrations/gmail/callback", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const connectedAccountId = (req.query.connected_account_id as string | undefined) ?? (req.query.connectionId as string | undefined);
  try {
    await gmailProvider(cfg, store, gmailCallbackUrl).handleCallback(userId, connectedAccountId);
    getLogger().info({ userId }, "gmail connection stored");
  } catch (e) {
    getLogger().error({ err: e, userId }, "gmail callback failed");
  }
  res.redirect(cfg.WEB_APP_URL ?? "/");
});

// GET /api/v1/integrations/gmail — status the UI renders the connect link from.
// If no local row exists, reconcile against Nango first: the Connect UI has no
// success redirect, so a Nango connection may exist without the local row (e.g.
// the tab closed mid-flow). A Nango outage falls through to connected:false.
integrationsRouter.get("/integrations/gmail", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const provider = gmailProvider(cfg, store, gmailCallbackUrl);
  let connection = await provider.getConnection(userId);
  if (!connection) {
    try {
      await provider.syncConnection(userId);
    } catch (e) {
      getLogger().error({ err: e, userId }, "gmail reconciliation failed");
    }
    connection = await provider.getConnection(userId);
  }
  res.json({ connected: connection != null });
});

// POST /api/v1/integrations/gmail/disconnect — revoke the Nango connection + drop
// the local row so the UI flips back to disconnected (chat page uses `gmail`).
integrationsRouter.post("/integrations/gmail/disconnect", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  await gmailProvider(cfg, store, gmailCallbackUrl).revoke(userId);
  getLogger().info({ userId }, "gmail connection revoked");
  res.json({ connected: false });
});

// GET /api/v1/integrations — the full roster with per-provider connected status
// (5.7.3: one settings page, not one page per provider).
integrationsRouter.get("/integrations", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const rows = await prisma.integrationConnection.findMany({ where: { userId }, select: { provider: true, status: true } });
  const statusByKey = new Map(rows.map((r) => [r.provider, r.status]));
  const nango = cfg.NANGO_SECRET_KEY != null;
  res.json({
    nangoConfigured: nango,
    integrations: ROSTER.map((r) => ({ ...r, connected: statusByKey.get(r.key) === "connected" })),
  });
});

// POST /api/v1/integrations/:providerKey/connect — connect-session/redirect for
// any roster provider. Gmail goes through the swap factory (Composio preferred);
// the rest of the roster stays on Nango. Responds with sessionToken (Nango's
// in-page widget) and/or authorizationUrl (Composio redirect).
integrationsRouter.post("/integrations/:providerKey/connect", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  const provider = key === GMAIL_INTEGRATION ? gmailProvider(cfg, store, gmailCallbackUrl) : providerForKey(key);
  if (!cfg.NANGO_SECRET_KEY && key !== GMAIL_INTEGRATION) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Integrations are not configured" } });
    return;
  }
  try {
    const { sessionToken, authorizationUrl } = await provider.initiateOAuth(userId);
    res.json({ sessionToken, authorizationUrl });
  } catch (e) {
    getLogger().error({ err: e, userId, provider: key }, "connect session failed");
    const err = mapConnectError(e);
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
});

// POST /api/v1/integrations/:providerKey/disconnect — revoke any roster provider.
// Does NOT require NANGO_SECRET_KEY: revoke() drops the local row even if the
// Nango call fails (best-effort upstream deletion).
integrationsRouter.post("/integrations/:providerKey/disconnect", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  await providerForKey(key).revoke(userId);
  getLogger().info({ userId, provider: key }, "integration revoked");
  res.json({ connected: false, key });
});

// GET /api/v1/integrations/:providerKey — per-provider connected status.
integrationsRouter.get("/integrations/:providerKey", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  const connection = await providerForKey(key).getConnection(userId);
  res.json({ connected: connection != null, key });
});

