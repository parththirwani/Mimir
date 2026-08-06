import { getConfig, getLogger, getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { requireAuth } from "../auth/auth.js";
import type { Request, Response } from "express";
import { Router } from "express";
import webpush from "web-push";

// Web Push (7.1): subscription management. Sending lives in delivery.ts (7.4),
// which shares sendPushToSubscriptions from here. VAPID is the crypto identity
// for push; missing keys disable push (events only reach users with a live
// socket — the message stays in the thread).

export const pushRouter: Router = Router();

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

// Set VAPID details once. web-push validates at send time, not here — missing
// keys just make setVapidDetails throw, so gate on their presence.
export function webpushConfigured(cfg: ReturnType<typeof getConfig>): boolean {
  return Boolean(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY && cfg.VAPID_SUBJECT);
}

function setVapid(cfg: ReturnType<typeof getConfig>): void {
  webpush.setVapidDetails(cfg.VAPID_SUBJECT!, cfg.VAPID_PUBLIC_KEY!, cfg.VAPID_PRIVATE_KEY!);
}

// Send a notification to every subscription a user has registered. Returns how
// many sends succeeded. Single best-effort try per sub (web-push validates the
// endpoint); an expired/stale endpoint is dropped via 404/410 so we don't retry
// it forever. Called by delivery.ts — the delivery decision point, not here.
export async function sendPushToSubscriptions(
  userId: string,
  cfg: ReturnType<typeof getConfig>,
  payload: PushPayload,
): Promise<number> {
  if (!webpushConfigured(cfg)) {
    return 0;
  }
  setVapid(cfg);
  const prisma = getPrismaClient();
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return 0;

  let delivered = 0;
  for (const sub of subs) {
    const keys = (sub.keys ?? {}) as { p256dh?: string; auth?: string };
    if (!keys.p256dh || !keys.auth) continue;
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: keys as { p256dh: string; auth: string },
        },
        JSON.stringify(payload),
      );
      delivered += 1;
    } catch (e) {
      const status = (e as { statusCode?: number | string })?.statusCode;
      if (status === 404 || status === 410) {
        getLogger().warn({ userId, endpoint: sub.endpoint }, "dropping expired push subscription");
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        getLogger().warn({ userId, err: e }, "push send failed");
      }
    }
  }
  return delivered;
}

// Subscribe: validate a browser PushSubscription and store it. endpoint is the
// unique key — a re-subscribe upserts.
pushRouter.post("/push/subscribe", requireAuth, async (req: Request, res: Response) => {
  const cfg = getConfig();
  if (!webpushConfigured(cfg)) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Web push is not configured" } });
    return;
  }
  const prisma = getPrismaClient();
  const userId = (req as Request & { userId?: string }).userId as string;
  const { endpoint, keys } = (req.body ?? {}) as { endpoint?: string; keys?: unknown };
  if (!endpoint || !keys) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "endpoint and keys are required" } });
    return;
  }
  try {
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId, endpoint, keys: keys as unknown as InputJsonValue, platform: "web" },
      update: { keys: keys as unknown as InputJsonValue },
    });
    res.json({ ok: true });
  } catch (e) {
    getLogger().warn({ err: e, userId }, "push subscribe failed");
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid push subscription" } });
  }
});

// Unsubscribe: delete by endpoint (the browser disables notifications).
pushRouter.post("/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as Request & { userId?: string }).userId as string;
  const { endpoint } = (req.body ?? {}) as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "endpoint is required" } });
    return;
  }
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  res.json({ ok: true });
});

// Whether the user has any subscription, for the settings toggle state.
pushRouter.get("/push/status", requireAuth, async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as Request & { userId?: string }).userId as string;
  const count = await prisma.pushSubscription.count({ where: { userId } });
  res.json({ enabled: count > 0 });
});

// VAPID public key for browser subscribe (applicationServerKey). Public on
// purpose — it's the identity half, not a secret.
pushRouter.get("/push/public-key", async (_req: Request, res: Response) => {
  const publicKey = getConfig().VAPID_PUBLIC_KEY;
  if (!publicKey) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Web push is not configured" } });
    return;
  }
  res.json({ publicKey });
});
