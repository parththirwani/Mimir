import { getConfig, getLogger } from "@mimir/backend-core";
import { Redis } from "ioredis";

export const redis = new Redis(getConfig().REDIS_URL, { maxRetriesPerRequest: 1 });

let redisErrorLogged = false;
redis.on("error", (e) => {
  if (!redisErrorLogged) {
    redisErrorLogged = true;
    getLogger().error({ err: e }, "redis connection error");
  }
});
