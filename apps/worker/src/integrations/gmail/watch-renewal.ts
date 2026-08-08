import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { GMAIL_INTEGRATION, gmailProvider } from "@mimir/connection-provider";
import { registerGmailWatch, type GmailTransport } from "./gmail.js";

// 6.2.2 — Gmail watch subscriptions expire (~7 days); this daily sweep re-registers
// watch() for every connected user so push keeps flowing. Gmail's watch is
// idempotent (re-registering returns the same watch), so no expiry bookkeeping is
// needed — the sweep just refreshes on cadence. Requires GOOGLE_PUBSUB_TOPIC.
const prisma = getPrismaClient();

export interface WatchRenewDeps {
  topic?: string;
  // Override the per-user Gmail transport (test seam). Defaults to the provider's
  // gmailRequest — the same transport the read/send paths use.
  request?: (userId: string) => GmailTransport;
}

export async function runWatchRenewal(deps: WatchRenewDeps = {}): Promise<number> {
  const cfg = getConfig();
  const topic = deps.topic ?? cfg.GOOGLE_PUBSUB_TOPIC;
  if (!topic) {
    getLogger().warn("gmail watch renewal skipped: GOOGLE_PUBSUB_TOPIC not configured");
    return 0;
  }
  const provider = gmailProvider(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
  const request = deps.request ?? ((userId: string): GmailTransport => (path, opts) => provider.gmailRequest(userId, path, opts));

  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GMAIL_INTEGRATION, status: "connected" },
    select: { userId: true },
  });

  let renewed = 0;
  for (const { userId } of connections) {
    try {
      await registerGmailWatch(request(userId), topic);
      renewed += 1;
      getLogger().info({ userId }, "gmail watch re-registered");
    } catch (e) {
      // Missing/expired connection or a transient Gmail/cloud error — log and
      // move on; the sweep retries next run.
      getLogger().info({ err: e, userId }, "gmail watch renewal failed for user; continuing");
    }
  }
  return renewed;
}
