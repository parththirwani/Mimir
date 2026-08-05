import { BROWSER_DAILY_MINUTES_CAP, getLogger } from "@mimir/backend-core";
import { redis } from "./redis.js";

// Browser budget stub (5.6): hosted browser sessions cost real money per minute,
// but Phase 10's real UsageRecord billing doesn't exist yet. A per-user-per-day
// Redis counter with a hard cap prevents a runaway loop from producing a
// surprise bill in the meantime. Same Redis-now->Postgres-later pattern as the
// mail-poll dedup set. Swap for UsageRecord at Phase 10.

const KEY = (userId: string, day: string) => `browser-minutes:${userId}:${day}`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Is the user under the daily cap right now? Checked before spawning a session.
export async function browserBudgetCheck(userId: string): Promise<boolean> {
  const used = Number(await redis.get(KEY(userId, today()))) || 0;
  if (used >= BROWSER_DAILY_MINUTES_CAP) {
    getLogger().warn({ userId, used }, "browser budget exhausted; refusing session");
    return false;
  }
  return true;
}

// Charge elapsed session minutes after the run. A session that overruns the cap
// is accepted (the cap gates starts, not stops) — the stopgap's known ceiling.
export async function recordBrowserMinutes(userId: string, minutes: number): Promise<void> {
  const key = KEY(userId, today());
  await redis.incrby(key, Math.max(1, Math.ceil(minutes)));
  if ((await redis.ttl(key)) === -1) await redis.expire(key, 48 * 60 * 60); // 2-day TTL covers a leap across midnight
}
