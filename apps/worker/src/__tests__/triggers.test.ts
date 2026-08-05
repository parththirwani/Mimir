import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "triggers-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { parseTriggerVerdict, validateTriggerFire } = await import("../agent/trigger-eval.js");
const { runTriggerSweep } = await import("../agent/triggers.js");

const prisma = getPrismaClient();
const userId = `triggers-${randomUUID()}`;
const email = `${userId}@test.local`;

const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };

let agentId: string;
let triggerId: string;
let conversationId: string;

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
});

afterAll(async () => {
  await prisma.trigger.deleteMany({ where: { agentId } });
  await prisma.agentEvent.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
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

    const job = await q.getJobs(["waiting", "delayed", "active"]);
    expect(job.length).toBeGreaterThanOrEqual(1);
    expect(job[0]?.data).toMatchObject({ agentId, trigger: "trigger_fired", triggerId });

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
});

describe("validateTriggerFire (4.11.6 fire-time re-check)", () => {
  test("match passes through", async () => {
    const ok = await validateTriggerFire(triggerId, { messages: [] }, {
      evaluate: async () => ({ matches: true, rationale: "still urgent" }),
    });
    expect(ok).toBe(true);
  });

  test("mismatch is logged as trigger_mismatch and never counted as fired", async () => {
    const ok = await validateTriggerFire(triggerId, { messages: [] }, {
      evaluate: async () => ({ matches: false, rationale: "criteria no longer holds" }),
    });
    expect(ok).toBe(false);

    const ev = await prisma.agentEvent.findFirst({
      where: { agentId, eventType: "trigger_mismatch" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev).toBeDefined();
    expect((ev?.payload as { triggerId?: string }).triggerId).toBe(triggerId);
  });
});