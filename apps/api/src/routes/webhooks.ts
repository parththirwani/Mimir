import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig, getLogger, getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { Router } from "express";

// Webhook ingress — Gmail/GitHub/Slack. Every endpoint:
//  1. verifies the provider signature (via injected fn) BEFORE any DB write,
//  2. rejects stale payloads (replay protection, 5-min),
//  3. INSERT ... ON CONFLICT (provider, externalId) DO NOTHING into WebhookEvent,
//     then the worker's webhook relay fans out to matching agents.
// The worker owns job dispatch (mirrors the outbox pattern, so the API never
// needs a BullMQ dependency); WebhookEvent's unique (provider, externalId) IS the
// idempotency mechanism — a duplicate delivery is a no-op insert.

const prisma = getPrismaClient();
const WEBHOOK_REPLAY_MAX_AGE_MS = 5 * 60 * 1000;

// ---- Signature verification primitives (pure, unit-testable) ----

// GitHub: HMAC-SHA256 of the raw body, sent as `sha256=<hex>`.
export function verifyGithubSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(expected, signature);
}

// Slack: versioned HMAC over `v0:<timestamp>:<rawBody>`; caller also
// checks the request timestamp for freshness.
export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");
}

export function verifySlackSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, secret: string): boolean {
  if (!timestamp || !signature) return false;
  return safeEqual(`v0=${slackSignature(secret, timestamp, rawBody)}`, signature);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Gmail's historyId is a PER-MAILBOX revision cursor, not globally unique. Every
// user's watch targets the shared Pub/Sub topic, so two mailboxes can be at the
// same historyId — a bare historyId would make the second user's real event a
// false "duplicate" (dedup is keyed on (provider, externalId) with no user
// scope). Namespace by mailbox so dedup is ownership-correct.
export function gmailExternalId(parsed: { historyId?: string; emailAddress?: string }, decoded: string): string {
  if (parsed.historyId) {
    const mailbox =
      parsed.emailAddress ?? `?${createHmac("sha256", "mailbox").update(decoded).digest("hex").slice(0, 16)}`;
    return `${mailbox}:${parsed.historyId}`;
  }
  return `pubsub:${createHmac("sha256", "gmail").update(decoded).digest("hex")}`;
}

// Replay protection: provider timestamp older than 5 minutes is rejected.
export function isStale(timestampMs: number, now: number = Date.now(), maxAgeMs: number = WEBHOOK_REPLAY_MAX_AGE_MS): boolean {
  return !Number.isFinite(timestampMs) || now - timestampMs > maxAgeMs;
}

// Google Cloud Pub/Sub: PushMessage auth is a Google-signed JWT in the
// `Authorization: Bearer` header whose `aud` equals the public endpoint URL. We
// verify against Google's published certs. Injectable for tests.
export interface GoogleVerifyFn {
  (token: string, audience: string): Promise<boolean>;
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export const verifyGooglePubSubJwt: GoogleVerifyFn = async (token, audience) => {
  try {
    const { payload } = await jwtVerify(token, googleKeys, { audience });
    return payload.iss === "accounts.google.com" || payload.iss === "https://accounts.google.com";
  } catch {
    return false;
  }
};

// ---- Router ----

export function webhooksRouter(opts: {
  cfg?: ReturnType<typeof getConfig>;
  verifyGoogle?: GoogleVerifyFn;
} = {}): Router {
  const cfg = opts.cfg ?? getConfig();
  const verifyGoogle = opts.verifyGoogle ?? verifyGooglePubSubJwt;
  const router: Router = Router();

  router.post("/gmail", async (req, res) => {
    if (!cfg.PUBLIC_API_URL) {
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "PUBLIC_API_URL is not configured" } });
      return;
    }
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing Google Push auth" } });
      return;
    }
    const ok = await verifyGoogle(token, cfg.PUBLIC_API_URL);
    if (!ok) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "invalid Google Push token" } });
      return;
    }
    const message = (req.body as { message?: { data?: string; publishTime?: string } })?.message;
    if (!message?.data) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "missing message.data" } });
      return;
    }
    // Replay protection: Pub/Sub PushMessage carries `publishTime`; reject
    // a push that Google published more than 5 minutes ago.
    if (isStale(Date.parse(message.publishTime ?? ""))) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "stale Google Push message" } });
      return;
    }
    // Pub/Sub PushMessage data is base64; for Gmail push it's a JSON string with
    // {historyId, emailAddress}. externalId = historyId (a monotonic cursor).
    let decoded: string;
    try {
      decoded = Buffer.from(message.data, "base64").toString("utf8");
    } catch {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "invalid base64 message" } });
      return;
    }
    let parsed: { historyId?: string; emailAddress?: string };
    try {
      parsed = JSON.parse(decoded) as { historyId?: string; emailAddress?: string };
    } catch {
      parsed = { historyId: undefined, emailAddress: undefined };
    }
    const externalId = gmailExternalId(parsed, decoded);
    res.status(200).json(await storeWebhook("gmail", externalId, parsed));
  });

  router.post("/github", async (req, res) => {
    if (!cfg.GITHUB_WEBHOOK_SECRET) {
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "GITHUB_WEBHOOK_SECRET is not configured" } });
      return;
    }
    const rawBody = (req as { rawBody?: string }).rawBody ?? "";
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGithubSignature(rawBody, sig, cfg.GITHUB_WEBHOOK_SECRET)) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "invalid GitHub signature" } });
      return;
    }
    const body = req.body as { delivery?: string; action?: string };
    const externalId = body.delivery ?? `github:${createHmac("sha256", "github").update(rawBody).digest("hex")}`;
    res.status(200).json(await storeWebhook("github", externalId, req.body));
  });

  router.post("/slack", async (req, res) => {
    const secret = cfg.SLACK_SIGNING_SECRET;
    if (!secret) {
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "SLACK_SIGNING_SECRET is not configured" } });
      return;
    }
    const rawBody = (req as { rawBody?: string }).rawBody ?? "";
    const tsHeader = req.headers["x-slack-request-timestamp"] as string | undefined;
    const sig = req.headers["x-slack-signature"] as string | undefined;
    const ts = Number(tsHeader);
    if (!verifySlackSignature(rawBody, tsHeader, sig, secret) || isStale(ts * 1000)) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "invalid Slack signature or stale timestamp" } });
      return;
    }
    const body = req.body as { event_id?: string; event?: { event_ts?: string } };
    const externalId = body.event_id ?? body.event?.event_ts ?? `slack:${createHmac("sha256", "slack").update(rawBody).digest("hex")}`;
    res.status(200).json(await storeWebhook("slack", externalId, req.body));
  });

  return router;
}

// INSERT ... ON CONFLICT (provider, externalId) DO NOTHING. The unique composite
// makes this atomic across concurrent/scale-out deliveries. Returns whether the
// row was newly stored (a duplicate delivery is a silent no-op) and its id.
export async function storeWebhook(provider: string, externalId: string, rawPayload: unknown): Promise<{ stored: boolean; id: string | null }> {
  const raw = rawPayload as Record<string, unknown>;
  try {
    const row = await prisma.webhookEvent.create({ data: { provider, externalId, rawPayload: raw as unknown as InputJsonValue } });
    getLogger().info({ provider, externalId, id: row.id }, "webhook event stored for processing");
    return { stored: true, id: row.id };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({ where: { provider_externalId: { provider, externalId } } });
      getLogger().info({ provider, externalId }, "webhook duplicate delivery (no-op)");
      return { stored: false, id: existing?.id ?? null };
    }
    throw e;
  }
}
