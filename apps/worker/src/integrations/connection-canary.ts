import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { gmailProvider } from "@mimir/connection-provider";

// The canary for the Composio raw-token extraction (see composio-provider's
// header note). Once a day, resolve getAccessToken for a real connected user and
// log loudly on failure — so a drift in Composio's connected-account shape (or a
// dead token) reaches a human from this job, not from a user's failed send days
// later. No-op unless CONNECTION_CANARY_USER_ID is configured, and it only
// reports — it never mutates state.
const prisma = getPrismaClient();

export async function runConnectionCanary(): Promise<void> {
  const cfg = getConfig();
  const userId = cfg.CONNECTION_CANARY_USER_ID;
  if (!userId) {
    return;
  }
  const provider = gmailProvider(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
  try {
    await provider.getAccessToken(userId);
    getLogger().info({ userId }, "connection canary ok");
  } catch (e) {
    // The loud path: either the connection is genuinely gone (expired/revoked —
    // still worth flagging) or getAccessToken's shape-check threw (ProviderError),
    // which is the silent-break we're hunting. Sentry picks this up via the
    // error-level logger.
    getLogger().error({ err: e, userId }, "connection canary FAILED — gmail connection/token extraction is broken");
  }
}