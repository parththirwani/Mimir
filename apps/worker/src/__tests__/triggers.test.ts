import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "triggers-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { parseTriggerVerdict, validateTriggerFire } = await import("../agent/trigger-eval.js");
const { runTriggerSweep } = await import("../agent/triggers.js");
const { drainOutbox } = await import("../infra/outbox-relay.js");

const prisma = getPrismaClient();
const userId = `triggers-${randomUUID()}`;
const email = `${userId}@test.local`;

const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };

let agentId: string;
let triggerId: string;
let conversationId: string;
// A trigger-less browser "research" agent: reactivation must NEVER reach it.
let researchAgentId: string;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
  const agent = await prisma.agent.create({
    data: { userId, ownerConversationId: conversationId, taskDescription: "watch for urgent email" },
  });
  agentId = agent.id;
  const trigger = await prisma.trigger.create({
    data: { agentId, name: "urgent mail", criteria: "an urgent email arrives" },
  });
  triggerId = trigger.id;
  const research = await prisma.agent.create({
    data: { userId, ownerConversationId: conversationId, taskDescription: "research what Graphify does", entity: "browser" },
  });
  researchAgentId = research.id;
});

afterAll(async () => {
  await prisma.trigger.deleteMany({ where: { agentId } });
  await prisma.agentEvent.deleteMany({ where: { agentId } });
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

// The sweep's cooldown (TRIGGER_COOLDOWN_MS) keys on lastFiredAt, which the
// shared trigger stamps when it fires. Reset it so each test starts cold and
// isn't silently skipped by the previous test's fire.
beforeEach(async () => {
  await prisma.trigger.updateMany({ where: { agentId }, data: { lastFiredAt: null } });
});

describe("parseTriggerVerdict", () => {
  test("parses a match", () => {
    expect(parseTriggerVerdict('{"matches":true,"rationale":"seen"}')).toEqual({ matches: true, rationale: "seen" });
  });

  test("rejects non-true matches and unparseable output (safe default)", () => {
    expect(parseTriggerVerdict('{"matches":false}').matches).toBe(false);
    expect(parseTriggerVerdict("nonsense").matches).toBe(false);
  });
});

describe("runTriggerSweep (4.11 scheduler tick)", () => {
  test("enqueues the owning agent job and stamps lastFiredAt when criteria match", async () => {
    const q = new Queue(`trigger-sweep-test-${Date.now()}`, { connection });
    const fired = await runTriggerSweep({
      evaluate: async () => ({ matches: true, rationale: "urgent mail present" }),
      queue: q,
    });
    expect(fired).toBeGreaterThanOrEqual(1);

    // Other test files may hold enabled triggers against the shared DB, so a
    // global-matching sweep enqueues more than our job here. Locate OURS by
    // agentId instead of assuming queue order on job[0].
    const jobs = await q.getJobs(["waiting", "delayed", "active"]);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const mine = jobs.find((j) => (j.data as { agentId?: string }).agentId === agentId);
    expect(mine).toBeDefined();
    expect(mine?.data).toMatchObject({ agentId, trigger: "trigger_fired", triggerId });

    const t = await prisma.trigger.findUnique({ where: { id: triggerId } });
    expect(t?.lastFiredAt).not.toBeNull();
    await q.close();
  });

  test("does not fire when criteria don't match", async () => {
    const q = new Queue(`trigger-sweep-nomatch-${Date.now()}`, { connection });
    const before = await q.getJobCounts("waiting");
    await runTriggerSweep({
      evaluate: async () => ({ matches: false, rationale: "nothing urgent" }),
      queue: q,
    });
    const after = await q.getJobCounts("waiting");
    expect((after.waiting ?? 0) - (before.waiting ?? 0)).toBe(0);
    await q.close();
  });

  test("reactivation is message-or-trigger only: sweep never enqueues a trigger-less agent", async () => {
    const q = new Queue(`trigger-sweep-invariant-${Date.now()}`, { connection });
    const fired = await runTriggerSweep({
      evaluate: async () => ({ matches: true, rationale: "urgent mail present" }),
      queue: q,
    });
    expect(fired).toBeGreaterThanOrEqual(1);

    const jobs = await q.getJobs(["waiting", "delayed", "active"]);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(
      jobs.some((j) => (j.data as { agentId?: string }).agentId === researchAgentId),
    ).toBe(false);
    expect(
      jobs.some((j) => (j.data as { agentId?: string }).agentId === agentId),
    ).toBe(true);
    await q.close();
  });
});

// A judge scoped to THIS user's trigger-owning agent: any other trigger in the
// shared test DB always "does not match", so enqueues on the throwaway queue are
// attributable to our fixtures and nothing else.
const judgeForAgent = (agentId: string, matches: boolean) =>
  async ({ agentId: a }: { agentId?: string }) => ({
    matches: a === agentId && matches,
    rationale: "scoped verdict",
  });

describe("reactivation boundary (message-or-trigger only)", () => {
  const agentJobIds = async (q: Queue, ...ids: string[]): Promise<string[]> => {
    const jobs = await q.getJobs(["waiting", "delayed", "active"]);
    return jobs.map((j) => (j.data as { agentId?: string }).agentId).filter((a): a is string => ids.includes(a ?? ""));
  };

  test("~10 minutes of repeated sweep ticks still enqueue zero jobs for the trigger-less agent", async () => {
    // The deleted poller re-ran every active agent roughly every 2 minutes and
    // kept firing for 11 minutes. Six swept ticks are the equivalent exposure
    // window: a single tick passing was the old test — this is the one that
    // would have caught the original bug, because the no-op held across every
    // tick, not just the first.
    const q = new Queue(`react-repeat-${Date.now()}`, { connection });
    for (let tick = 1; tick <= 6; tick++) {
      await runTriggerSweep({ evaluate: judgeForAgent(agentId, true), queue: q });
      const ours = await agentJobIds(q, agentId, researchAgentId);
      // Per-tick assertion: the target agent is ALWAYS absent, including on the
      // trigger-owner's firing ticks.
      expect(ours.filter((a) => a === researchAgentId)).toEqual([]);
    }
    const cumulative = await agentJobIds(q, agentId, researchAgentId);
    expect(cumulative.filter((a) => a === researchAgentId)).toEqual([]);
    await q.close();
  });

  test("a trigger-owning agent is enqueued only at/after its due tick, never early", async () => {
    // No blind timer may enqueue an agent ahead of its trigger actually firing.
    // Simulate a clock: for the first 9 minutes the trigger isn't due (criteria
    // don't match) and the sweep must stay empty; the moment it turns due
    // (matching criteria at its scheduled tick) the owner is enqueued.
    const q = new Queue(`react-due-${Date.now()}`, { connection });
    for (let minute = 1; minute <= 9; minute++) {
      await runTriggerSweep({ evaluate: judgeForAgent(agentId, false), queue: q });
      expect(await agentJobIds(q, agentId)).toEqual([]);
    }
    await runTriggerSweep({ evaluate: judgeForAgent(agentId, true), queue: q });
    const afterDue = await agentJobIds(q, agentId);
    expect(afterDue).toContain(agentId);
    await q.close();
  });

  test("a mixed-roster sweep enqueues ONLY the trigger owner — no leak into the general roster", async () => {
    const q = new Queue(`react-roster-${Date.now()}`, { connection });
    await runTriggerSweep({ evaluate: judgeForAgent(agentId, true), queue: q });
    // Over THIS user's two agents, exactly one job, and it belongs to the
    // trigger owner — the sweep never fans out over the roster.
    const ours = (await agentJobIds(q, agentId, researchAgentId)).filter(
      (a) => a === agentId || a === researchAgentId,
    );
    expect(ours).toEqual([agentId]);
    await q.close();
  });

  test("a new user message still reactivates the trigger-less agent (message-routed path survives)", async () => {
    // We deleted one reactivation path (the blind poller); the two that remain
    // must both still work. This one proves the message path: an outbox row
    // addressed to the trigger-less research agent is relayed to agent-jobs the
    // same as any other spawn.
    const row = await prisma.outboxEvent.create({
      data: { eventType: "spawn_agent", payload: { agentId: researchAgentId, trigger: "user_message" } },
    });
    try {
      const q = new Queue(`react-msg-${Date.now()}`, { connection });
      const enqueued = await drainOutbox(q);
      expect(enqueued).toBeGreaterThanOrEqual(1);
      const jobs = await q.getJobs(["waiting", "delayed", "active"]);
      expect(jobs.some((j) => (j.data as { agentId?: string }).agentId === researchAgentId)).toBe(true);
      expect(jobs.some((j) => (j.data as { agentId?: string }).agentId === agentId)).toBe(false);
      await q.close();
    } finally {
      await prisma.outboxEvent.deleteMany({ where: { id: row.id } });
    }
  });
});

describe("validateTriggerFire (4.11.6 fire-time re-check)", () => {
  test("match passes through", async () => {
    const ok = await validateTriggerFire(triggerId, { messages: [] }, {
      evaluate: async () => ({ matches: true, rationale: "still urgent" }),
    });
    expect(ok).toBe(true);
  });

  test("mismatch is logged as trigger_skipped and never counted as fired", async () => {
    const ok = await validateTriggerFire(triggerId, { messages: [] }, {
      evaluate: async () => ({ matches: false, rationale: "criteria no longer holds" }),
    });
    expect(ok).toBe(false);

    const ev = await prisma.agentEvent.findFirst({
      where: { agentId, eventType: "trigger_skipped" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev).toBeDefined();
    expect((ev?.payload as { triggerId?: string }).triggerId).toBe(triggerId);
  });
});