import { getLogger, getPrismaClient } from "@mimir/backend-core";
import type { Redis } from "ioredis";
import { agentJobs, retryPolicy } from "./queues.js";
import { redis } from "./redis.js";

// Adaptive per-Connection polling fallback (6.4) for non-webhook providers, and
// the reconciliation backstop (6.3). One scheduled 1-min tick drives it; each
// connection keeps its OWN adaptive interval in Redis (start 60s, ×2 on quiet
// polls, cap 15min, reset to 60s on activity). When a connection is due, it fans
// out to EVERY active, non-dormant TASK agent matching that connection by entity
// (6.4.2 — one poll, many agents), which re-fetches + filter-before-surfaces.
// Dormant agents are excluded by construction (the query only selects active).

const prisma = getPrismaClient();

export const ADAPTIVE_POLL_CRON = "* * * * *"; // 6.4.1 tick
export const RECONCILE_CRON = "*/30 * * * *"; // 6.3 safety net

const START_MS = 60_000;
const MAX_MS = 15 * 60_000;

const recKey = (userId: string, provider: string) => `conn-poll:${userId}:${provider}`;

export interface AdaptiveDeps {
  cache?: Redis;
  queue?: typeof agentJobs;
  now?: () => number;
  force?: boolean; // reconciliation: ignore per-connection intervals
}

// Returns the number of agent jobs enqueued this tick.
export async function runAdaptivePolling(deps: AdaptiveDeps = {}): Promise<number> {
  const cache = deps.cache ?? redis;
  const q = deps.queue ?? agentJobs;
  const now = deps.now ?? Date.now;
  const force = deps.force ?? false;

  const agents = await prisma.agent.findMany({
    where: { status: "active", entity: { not: null } },
    select: { id: true, userId: true, entity: true },
  });

  const groups = new Map<string, { userId: string; provider: string; agentIds: string[] }>();
  for (const a of agents) {
    if (!a.entity) continue;
    const gk = `${a.userId}:${a.entity}`;
    const g = groups.get(gk) ?? { userId: a.userId, provider: a.entity, agentIds: [] };
    g.agentIds.push(a.id);
    groups.set(gk, g);
  }

  let enqueued = 0;
  for (const [gk, g] of groups) {
    const key = recKey(g.userId, g.provider);
    const rec = await cache.hgetall(key);
    const lastPoll = Number(rec.last ?? 0);
    const iv = Number(rec.interval ?? START_MS) || START_MS;
    const due = force || now() - lastPoll >= iv;
    if (!due) continue;

    // jobId unique per (group, agent, minute) so consecutive enqueues for the
    // same agent within a tick can't double-fire; the minute suffix lets the
    // NEXT poll's run go through. BullMQ forbids ':' in custom ids.
    const safeKey = gk.replace(/:/g, "-");
    for (const id of g.agentIds) {
      await q.add("execute", { agentId: id, trigger: "poll" }, { ...retryPolicy, jobId: `poll-${safeKey}-${id}-${Math.floor(now() / 60000)}` });
      enqueued += 1;
    }

    // Adapt the interval: any surfaced event since the last poll = activity ->
    // reset to 60s; otherwise double (cap 15min).
    const surfaced = await prisma.agentEvent.count({
      where: { agentId: { in: g.agentIds }, eventType: "surfaced", createdAt: { gt: new Date(lastPoll || 0) } },
    });
    const nextIv = surfaced > 0 ? START_MS : Math.min(iv * 2, MAX_MS);
    await cache.hset(key, { last: String(now()), interval: String(nextIv) });
    getLogger().info({ provider: g.provider, userId: g.userId, agents: g.agentIds.length, intervalMs: nextIv, surfaced }, "adaptive poll fired");
  }
  return enqueued;
}
