import { AGENT_DORMANCY_DAYS, getLogger, getPrismaClient } from "@mimir/backend-core";

const prisma = getPrismaClient();

// Plan 4.8.1: daily sweep — agents with no AgentEvent in AGENT_DORMANCY_DAYS become dormant.
// Excluded from dedup candidates (agent.ts filters status='active') and Phase 6 polling.
export async function runDormancySweep(): Promise<number> {
  const cutoff = new Date(Date.now() - AGENT_DORMANCY_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.$executeRaw`
    UPDATE "Agent" a
    SET status = 'dormant'
    WHERE a.status = 'active'
      AND a."lastActiveAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "AgentEvent" e WHERE e."agentId" = a.id AND e."createdAt" >= ${cutoff})
  `;
  getLogger().info({ count: result }, "dormancy sweep ran");
  return result;
}
