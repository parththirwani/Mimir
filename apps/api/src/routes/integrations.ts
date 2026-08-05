import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { NangoConnectionProvider } from "@mimir/connection-provider";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";

const cfg = getConfig();
const prisma = getPrismaClient();

// Nango-backed Gmail OAuth. Config-only values are injected from getConfig() —
// the provider package itself stays dependency-free.
function gmailProvider(): NangoConnectionProvider {
  return new NangoConnectionProvider({
    secretKey: cfg.NANGO_SECRET_KEY,
    host: cfg.NANGO_BASE_URL,
    store: prisma.integrationConnection,
  });
}

export const integrationsRouter: Router = Router();

// GET /api/v1/integrations/gmail/connect — create a connect session; the token
// opens Nango's Connect UI in-page (the app never navigates to authorizationUrl).
integrationsRouter.get("/integrations/gmail/connect", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!cfg.NANGO_SECRET_KEY) {
    getLogger().warn("gmail connect requested but nango not configured");
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Gmail integration is not configured" } });
    return;
  }
  const { sessionToken } = await gmailProvider().initiateOAuth(userId);
  res.json({ sessionToken });
});

// GET /api/v1/integrations/gmail/callback — Nango's success URL. Session cookie
// rides the same browser so req.userId is available. Always redirect back to the
// app; a failed upsert is logged, not fatal.
integrationsRouter.get("/integrations/gmail/callback", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  try {
    await gmailProvider().handleCallback(userId);
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
  const provider = gmailProvider();
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
