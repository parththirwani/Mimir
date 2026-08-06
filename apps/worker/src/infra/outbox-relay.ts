import { getLogger, getPrismaClient } from "@mimir/backend-core";
import { agentJobs, emailJobs, retryPolicy } from "./queues.js";
import { pollLoop } from "./poll-loop.js";

const prisma = getPrismaClient();

// Poll OutboxEvent for unprocessed rows, enqueue the real BullMQ job, then mark
// processedAt. Polling (not a stream) is what makes this crash-safe: a Redis
// outage mid-spawn loses nothing — the row stays unprocessed until the next tick.
// jobId = outbox row id so BullMQ dedupes a re-polled row.
// (BullMQ 6 forbids ':' in custom job IDs, hence the '-' separator.)
// `queue`/`emailQueue` are injectable so tests can hand in their own connections.
export async function drainOutbox(
  queue = agentJobs,
  emailQueue = emailJobs,
  batchSize = 50,
): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
  let enqueued = 0;
  for (const row of rows) {
    if (row.eventType === "email_send") {
      try {
        await emailQueue.add("send", row.payload, { ...retryPolicy, jobId: `outbox-${row.id}` });
        await prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
        enqueued += 1;
        getLogger().info({ outboxId: row.id }, "email send outbox row relayed to email-jobs");
      } catch (e) {
        getLogger().error({ err: e, outboxId: row.id }, "email send outbox relay failed; row left unprocessed for retry");
      }
      continue;
    }
    const payload = row.payload as { agentId?: string; trigger?: string; context?: unknown };
    if (!payload.agentId) {
      getLogger().warn({ outboxId: row.id, eventType: row.eventType }, "outbox row missing agentId; skipping");
      await prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
      continue;
    }
    try {
      await queue.add(
        "execute",
        { agentId: payload.agentId, trigger: payload.trigger ?? "user_message", context: payload.context },
        { ...retryPolicy, jobId: `outbox-${row.id}` },
      );
      await prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
      enqueued += 1;
      getLogger().info({ outboxId: row.id, agentId: payload.agentId }, "outbox row relayed to agent-jobs");
    } catch (e) {
      getLogger().error({ err: e, outboxId: row.id }, "outbox relay failed; row left unprocessed for retry");
    }
  }
  return enqueued;
}

// The relay loop: every few seconds, drain unprocessed rows. Returns a stop handle.
export function startOutboxRelay(intervalMs = 3000): () => void {
  return pollLoop(() => drainOutbox(), "outbox", intervalMs);
}
