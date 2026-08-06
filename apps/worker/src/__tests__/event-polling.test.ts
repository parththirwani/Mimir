import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "adaptive-poll-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { runAdaptivePolling } = await import("../infra/event-polling.js");

const prisma = getPrismaClient();
const q = new Queue("agent-jobs", { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } });

const userId = `apoll-${randomUUID()}`;
const convId = `apoll-conv-${randomUUID()}`;
const gmailAgent = `apoll-gmail-${randomUUID()}`;
const gmailDormant = `apoll-gmail-dorm-${randomUUID()}`;
const browserAgent = `apoll-browser-${randomUUID()}`;
const enqueued: string[] = [];

function fakeCache(seed: Record<string, string> = {}): Redis {
  const stores = new Map<string, Record<string, string>>();
  const mk = (key: string) => {
    let s = stores.get(key);
    if (!s) {
      s = {};
      Object.assign(s, seed);
      stores.set(key, s);
    }
    return s;
  };
  return {
    hgetall: async (key: string) => ({ ...mk(key) }),
    hset: async (key: string, fields: Record<string, string>) => {
      Object.assign(mk(key), fields);
      return 1;
    },
  } as unknown as Redis;
}

const t = 1_000_000_000_000;
const fakeNow = () => t;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
  await prisma.agent.createMany({
    data: [
      { id: gmailAgent, userId, ownerConversationId: convId, taskDescription: "watch gmail", entity: "gmail", status: "active" },
      { id: gmailDormant, userId, ownerConversationId: convId, taskDescription: "dormant gmail", entity: "gmail", status: "dormant" },
      { id: browserAgent, userId, ownerConversationId: convId, taskDescription: "watch browser", entity: "browser", status: "active" },
    ],
  });
});

afterAll(async () => {
  for (const id of enqueued) await q.getJob(id).then((j) => j?.remove());
  await prisma.agentEvent.deleteMany({ where: { agentId: gmailAgent } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await q.close();
});

describe("runAdaptivePolling (6.4)", () => {
  test("fans out to ACTIVE task agents by entity only; dormant excluded", async () => {
    const cache = fakeCache({ last: "0" }); // definitely due
    const enqueuedN = await runAdaptivePolling({ cache, queue: q, now: fakeNow });
    // Shared test DB may hold OTHER users' active agents, so don't assert an
    // exact total — assert our specific agents were/were-not enqueued.
    expect(enqueuedN).toBeGreaterThanOrEqual(2);

    const pollMinute = Math.floor(fakeNow() / 60000);
    const gmailJobId = `poll-${userId}-gmail-${gmailAgent}-${pollMinute}`;
    const browserJobId = `poll-${userId}-browser-${browserAgent}-${pollMinute}`;
    enqueued.push(gmailJobId, browserJobId);

    const gmail = await q.getJob(gmailJobId);
    const dormant = await q.getJob(`poll-${userId}-gmail-${gmailDormant}-${pollMinute}`);
    expect(gmail?.data).toMatchObject({ agentId: gmailAgent, trigger: "poll" });
    expect(dormant ?? null).toBeNull();
  });

  test("no surfaced activity since last poll doubles the interval; forced reconcile ignores it", async () => {
    const cache = fakeCache({ last: "0", interval: String(2 * 60_000) });
    await runAdaptivePolling({ cache, queue: q, now: fakeNow });
    const pollMinute = Math.floor(fakeNow() / 60000);
    enqueued.push(`poll-${userId}-gmail-${gmailAgent}-${pollMinute}`, `poll-${userId}-browser-${browserAgent}-${pollMinute}`);
    // Our gmail group had no surfaced events -> interval doubles from 120s to 240s.
    const rec = await cache.hgetall(`conn-poll:${userId}:gmail`);
    expect(rec.interval).toBe(String(240_000));

    // Force (reconciliation, 6.3) ignores due-ness: last is set to now but the
    // connection still fires because force=true.
    const forceCache = fakeCache({ last: String(t), interval: String(15 * 60_000) });
    const fired = await runAdaptivePolling({ cache: forceCache, queue: q, now: fakeNow, force: true });
    const gmailJob = await q.getJob(`poll-${userId}-gmail-${gmailAgent}-${pollMinute}`);
    enqueued.push(`poll-${userId}-browser-${browserAgent}-${pollMinute}`);
    expect(fired).toBeGreaterThanOrEqual(1);
    expect(gmailJob?.data).toMatchObject({ agentId: gmailAgent, trigger: "poll" });
  });

  test("surfaced activity since last poll resets the interval to 60s", async () => {
    await prisma.agentEvent.create({ data: { agentId: gmailAgent, eventType: "surfaced", payload: { content: "hi" } } });
    // last 30min ago with an 8-min interval => due; surfaced event present => reset to 60s.
    const cache = fakeCache({ last: String(t - 30 * 60 * 1000), interval: String(8 * 60_000) });
    await runAdaptivePolling({ cache, queue: q, now: fakeNow });
    const pollMinute = Math.floor(fakeNow() / 60000);
    enqueued.push(`poll-${userId}-gmail-${gmailAgent}-${pollMinute}`, `poll-${userId}-browser-${browserAgent}-${pollMinute}`);
    // gmail agent has a surfaced event -> interval stored should be START (60s)
    const rec = await cache.hgetall(`conn-poll:${userId}:gmail`);
    expect(rec.interval).toBe(String(60_000));
  });
});
