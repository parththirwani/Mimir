import { getLogger, getPrismaClient, MAIL_NOISE_TTL_SECONDS, SURFACED_MAIL_TTL_SECONDS } from "@mimir/backend-core";
import { GMAIL_INTEGRATION } from "@mimir/connection-provider";
import type { Redis } from "ioredis";
import { fetchEntityData, type GmailMessage } from "../integrations/gmail/gmail.js";
import { filterVerdict } from "../agent/agent-execution.js";
import { publishUserEvent, redis } from "./redis.js";

const prisma = getPrismaClient();

// Fixed-cadence sweep over every user's connected Gmail, surfacing NEW messages
// the noise filter deems worth seeing. One scheduled job, no push watch, no
// per-connection backoff — reuse of the existing fetch + filter primitives.

const SURFACED_KEY = (userId: string) => `mail-surfaced:${userId}`;
// A "noise" verdict is NOT claimed permanently: the filter is cheap and can
// misfire (the meeting-invite case). Held in a short-TTL set instead, so a
// borderline email gets re-judged after MAIL_NOISE_TTL_SECONDS instead of being
// dropped for the full surfaced window.
const NOISE_KEY = (userId: string) => `mail-noise:${userId}`;

// Dedup is a Redis set of surfaced Gmail message ids. Worst case on Redis loss:
// a message re-surfaces once — acceptable vs. building a Postgres cursor table.
async function isSurfaced(cache: Redis, userId: string, messageId: string): Promise<boolean> {
  return (await cache.sismember(SURFACED_KEY(userId), messageId)) === 1;
}

// Noise cooldown membership: true means the mail was judged noise recently and
// is still within its re-judge window — skip it this sweep.
async function isNoiseCooldown(cache: Redis, userId: string, messageId: string): Promise<boolean> {
  return (await cache.sismember(NOISE_KEY(userId), messageId)) === 1;
}

async function markNoise(cache: Redis, userId: string, messageId: string, ttlSeconds: number): Promise<void> {
  const key = NOISE_KEY(userId);
  await cache.sadd(key, messageId);
  if ((await cache.ttl(key)) === -1) {
    await cache.expire(key, ttlSeconds);
  }
}

// Atomic claim: returns true only when this call added the member. A concurrent
// sweep returns false and skips the write. TTL set only on a fresh key so active
// users don't keep the set alive forever.
async function markSurfaced(cache: Redis, userId: string, messageId: string): Promise<boolean> {
  const key = SURFACED_KEY(userId);
  const added = await cache.sadd(key, messageId);
  if (added === 1 && (await cache.ttl(key)) === -1) {
    await cache.expire(key, SURFACED_MAIL_TTL_SECONDS);
  }
  return added === 1;
}

function renderMail(m: GmailMessage): string {
  const header: string[] = [];
  if (m.listUnsubscribe) header.push(`List-Unsubscribe: ${m.listUnsubscribe}`);
  if (m.inReplyTo) header.push(`In-Reply-To: ${m.inReplyTo}`);
  const head = header.length ? `\n${header.join("\n")}` : "";
  return `From: ${m.from}\nSubject: ${m.subject}\nReceived: ${m.receivedAt}${head}\n\n${m.body}`;
}

// find-or-create the user's single persistent conversation (mirrors message.ts):
// the chat API resolves it as the user's first conversation, so surface mail into
// that same thread deterministically.
async function ownerConversation(userId: string): Promise<string> {
  const existing = await prisma.conversation.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const conv = await prisma.conversation.create({ data: { userId } });
  return conv.id;
}

export interface MailPollDeps {
  cache?: Redis;
  fetch?: typeof fetchEntityData;
  filter?: typeof filterVerdict;
  publish?: typeof publishUserEvent;
  // Re-judge window for noise verdicts. Injectable for tests; defaults to the
  // production constant (24h).
  noiseTtlSeconds?: number;
}

// Sweep all connected Gmail accounts for new, important mail. Returns the count
// of messages surfaced this tick. Best-effort per user — one user's failure must
// not block the rest of the sweep.
export async function pollImportantMail(deps: MailPollDeps = {}): Promise<number> {
  const cache = deps.cache ?? redis;
  const fetchData = deps.fetch ?? fetchEntityData;
  const judge = deps.filter ?? filterVerdict;
  const publish = deps.publish ?? publishUserEvent;
  const noiseTtlSeconds = deps.noiseTtlSeconds ?? MAIL_NOISE_TTL_SECONDS;

  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GMAIL_INTEGRATION, status: "connected" },
    select: { userId: true },
  });
  if (connections.length === 0) return 0;

  let surfaced = 0;
  for (const { userId } of connections) {
    try {
      const data = await fetchData(userId, "gmail", "");
      const messages = data.messages ?? [];
      for (const msg of messages) {
        if (await isSurfaced(cache, userId, msg.id)) continue;
        // Recently-judged noise stays quiet until its re-judge window lapses.
        if (await isNoiseCooldown(cache, userId, msg.id)) continue;
        const verdict = await judge(userId, renderMail(msg), "email");
        // A filter failure (error flag) is NOT a verdict: don't claim the mail so
        // the next sweep retries it instead of permanently dropping the notification.
        if (verdict.error) continue;
        // Noise is held briefly, not claimed: a bad filter call on a real meeting
        // invite is retried after the cooldown instead of being lost for 30 days.
        if (!verdict.surface) {
          await markNoise(cache, userId, msg.id, noiseTtlSeconds);
          continue;
        }
        // Claim before writing: only the first claimant in a concurrent sweep proceeds.
        if (!(await markSurfaced(cache, userId, msg.id))) continue;
        const conversationId = await ownerConversation(userId);
        const message = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: `Important email:\n\n${renderMail(msg)}\n\n${verdict.rationale ?? ""}`.trim(),
            status: "complete",
          },
        });
        surfaced += 1;
        getLogger().info({ userId, messageId: msg.id, category: verdict.category }, "important mail surfaced");
        try {
          await publish(userId, "new_message", { conversationId, messageId: message.id });
        } catch (publishErr) {
          getLogger().error({ err: publishErr, userId }, "mail publish failed (message already written)");
        }
      }
    } catch (e) {
      getLogger().error({ err: e, userId }, "mail poll failed for user; continuing sweep");
    }
  }
  return surfaced;
}