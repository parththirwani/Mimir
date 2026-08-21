import { getLogger, getPrismaClient, MAIL_NOISE_TTL_SECONDS } from "@mimir/backend-core";
import { ConnectionError, GMAIL_INTEGRATION } from "@mimir/connection-provider";
import type { Redis } from "ioredis";
import { fetchEntityData, type GmailMessage } from "../integrations/gmail/gmail.js";
import { triageVerdict, type TriageVerdict } from "../agent/triage.js";
import { publishUserEvent, newMessagePayload, redis } from "./redis.js";

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

// The judge reads the same render as the user, minus the plumbing the user
// never asked for: List-Unsubscribe/In-Reply-To stay for the filter's bulk-mailer
// signal, but the surfaced message shows a human email preview instead.
function renderMail(m: GmailMessage, opts?: { forUser?: boolean; timezone?: string | null }): string {
  const header: string[] = [];
  if (!opts?.forUser) {
    if (m.listUnsubscribe) header.push(`List-Unsubscribe: ${m.listUnsubscribe}`);
    if (m.inReplyTo) header.push(`In-Reply-To: ${m.inReplyTo}`);
  }
  const head = header.length ? `\n${header.join("\n")}` : "";
  const received = opts?.forUser ? localizeReceived(m.receivedAt, opts.timezone) : m.receivedAt;
  return `From: ${m.from}\nSubject: ${m.subject}\nReceived: ${received}${head}\n\n${m.body}`;
}

// The user's IANA tz comes from their browser (POST /user/timezone). Unknown or
// garbage tz falls back to the raw ISO string.
function localizeReceived(iso: string, timezone?: string | null): string {
  if (!iso || !timezone) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
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
  // The triage judge. Tests inject a deterministic one; the production
  // default is triageVerdict. Compatibility: tests may pass an extra `kind` arg,
  // so type it loosely enough to accept either.
  filter?: (userId: string, content: string, kind?: string) => Promise<TriageVerdict>;
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
  // Triage classifier (stricter, default-to-false) is the judge for this
  // unwatched-inbox surfacing, distinct from the async filter (which gates
  // watched agents). Injectable so tests can hand in a deterministic judge.
  const judge = deps.filter ?? triageVerdict;
  const publish = deps.publish ?? publishUserEvent;
  const noiseTtlSeconds = deps.noiseTtlSeconds ?? MAIL_NOISE_TTL_SECONDS;

  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GMAIL_INTEGRATION, status: "connected" },
    select: { userId: true, user: { select: { timezone: true } } },
  });
  if (connections.length === 0) return 0;

  let surfaced = 0;
  for (const { userId, user } of connections) {
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
        // Durable, Postgres-claimed dedup — the source of truth. The unique PK
        // on messageId makes the claim atomic across concurrent sweeps and
        // survives a Redis flush: a re-poll can never re-surface the same mail.
        // The Redis set is kept as the cheap fast-path filter only.
        try {
          await prisma.surfacedMail.create({ data: { messageId: msg.id, userId } });
        } catch (e) {
          if ((e as { code?: string }).code === "P2002") {
            getLogger().info({ userId, messageId: msg.id }, "mail dedup skip (already claimed in postgres)");
            // Re-add the fast-path Redis marker so future sweeps skip via cache.
            await cache.sadd(SURFACED_KEY(userId), msg.id).catch(() => {});
            continue;
          }
          throw e;
        }
        await cache.sadd(SURFACED_KEY(userId), msg.id).catch(() => {});
        const conversationId = await ownerConversation(userId);
        const message = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: `Important email:\n\n${renderMail(msg, { forUser: true, timezone: user?.timezone })}\n\n${verdict.rationale ?? ""}`.trim(),
            status: "complete",
          },
        });
        surfaced += 1;
        getLogger().info({ userId, messageId: msg.id, category: verdict.category }, "important mail surfaced");
        try {
          await publish(userId, "new_message", newMessagePayload(conversationId, message));
        } catch (publishErr) {
          getLogger().error({ err: publishErr, userId }, "mail publish failed (message already written)");
        }
      }
    } catch (e) {
      getLogger().error({ err: e, userId }, "mail poll failed for user; continuing sweep");
      // A dead connection (revoked/expired token, fail-fast) must flip the local
      // row so the UI stops claiming "connected". Mirrors the agent-execution
      // fail-fast flip; other errors are best-effort and just logged.
      if (e instanceof ConnectionError) {
        await prisma.integrationConnection.updateMany({
          where: { userId, provider: GMAIL_INTEGRATION },
          data: { status: "expired" },
        });
        getLogger().info({ userId }, "gmail connection marked expired from poll failure");
      }
    }
  }
  return surfaced;
}