import { getLogger, getPrismaClient } from "@mimir/backend-core";
import { agentJobs, retryPolicy } from "./queues.js";
import { pollLoop } from "./poll-loop.js";

// Webhook processing (6.1.4): the api only INSERTs verified WebhookEvents; this
// relay (mirror of the 4.4 outbox pattern) polls unprocessed rows, fans each out
// to the matching ACTIVE TASK agents by entity (6.4.2 — one webhook, many agents),
// then marks processedAt. Polling (not a stream) is what keeps it crash-safe:
// a Redis/worker outage loses nothing — the row stays unprocessed until the next
// tick. The agent's own run re-fetches live data + filter-before-surfacing (4.7)
// decides whether the change surfaces, so a wake is cheap and rarely spammy.
const prisma = getPrismaClient();

export async function drainWebhookEvents(queue = agentJobs, batchSize = 50): Promise<number> {
  const rows = await prisma.webhookEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
  let processed = 0;
  for (const row of rows) {
    try {
      const agents = await prisma.agent.findMany({
        where: { entity: row.provider, status: "active" },
        select: { id: true },
      });
      const context = JSON.stringify(row.rawPayload ?? {});
      for (const { id } of agents) {
        await queue.add(
          "execute",
          { agentId: id, trigger: "webhook", context },
          { ...retryPolicy, jobId: `webhook-${row.id}-${id}` },
        );
      }
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
      processed += 1;
      getLogger().info({ webhookId: row.id, agentCount: agents.length }, "webhook row relayed to agent-jobs");
    } catch (e) {
      getLogger().error({ err: e, webhookId: row.id }, "webhook relay failed for row; left unprocessed for retry");
    }
  }
  return processed;
}

// The relay loop: every few seconds, drain unprocessed webhook rows.
export function startWebhookRelay(intervalMs = 3000): () => void {
  return pollLoop(() => drainWebhookEvents(), "webhook", intervalMs);
}
