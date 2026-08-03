import { getConfig, getLogger } from "@mimir/backend-core";
import { Redis } from "ioredis";

const cfg = getConfig();

// Phase 4.6's publisher: worker writes the AgentEvent to Postgres first, then
// publishes here so api's pub/sub subscriber (Phase 3.3) delivers via socket.
export const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on("error", (e) => getLogger().error({ err: e }, "worker redis error"));

export async function publishUserEvent(userId: string, event: string, payload: unknown): Promise<void> {
  await redis.publish(`user-events:${userId}`, JSON.stringify({ event, payload, at: new Date().toISOString() }));
}
