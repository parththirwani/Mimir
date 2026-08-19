import { loadEnv } from "./intent-iteration/_env.js";
import { Redis } from "ioredis";

// Phase 11 checkpoint driver: publish a fake `user-events:{userId}` message so
// the api's delivery fallback (socket -> web push) can be verified without a
// real agent/Gmail event. Exercise: close the app entirely, run this, and the
// notification should arrive; with the app open it lands on the live socket.
//
// Usage: bun scripts/simulate-event.ts <userId> [content]
// Needs REDIS_URL in .env (or exported).

loadEnv();

const userId = process.argv[2];
if (!userId) {
  console.error("usage: bun scripts/simulate-event.ts <userId> [content]");
  process.exit(1);
}
const content = process.argv[3] ?? "Test delivery event — open Mimir to see it.";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL not set");
  process.exit(1);
}

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
await redis.publish(
  `user-events:${userId}`,
  JSON.stringify({ event: "new_message", payload: { content }, at: new Date().toISOString() }),
);
console.log(`published new_message -> user-events:${userId}`);
await redis.quit();