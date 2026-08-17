import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// agent.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "agent-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ANSWER_DIRECTLY, archiveAgents, findDuplicateByVector, isPureGreeting, parseClassification, parseRewrite, rewriteHistoryContext } = await import("../agent/agent.js");

const prisma = getPrismaClient();

describe("parseClassification", () => {
  test("valid spawn_agent with confidence >= 0.5 is accepted", () => {
    const c = parseClassification('{"action":"spawn_agent","targetAgentId":null,"taskDescription":"check email","confidence":0.9}');
    expect(c).toEqual({ action: "spawn_agent", taskDescription: "check email", confidence: 0.9 });
  });

  test("confidence below 0.5 forces answer_directly", () => {
    expect(parseClassification('{"action":"spawn_agent","taskDescription":"check email","confidence":0.4}')).toEqual(ANSWER_DIRECTLY);
  });

  test("garbage input forces answer_directly", () => {
    expect(parseClassification("sure, I'll watch your inbox!")).toEqual(ANSWER_DIRECTLY);
  });

  test("malformed json forces answer_directly", () => {
    expect(parseClassification('{"action":')).toEqual(ANSWER_DIRECTLY);
  });

  test("answer_directly passes through", () => {
    expect(parseClassification('{"action":"answer_directly"}')).toEqual(ANSWER_DIRECTLY);
  });

  test("json fenced in code blocks is handled", () => {
    const c = parseClassification('```json\n{"action":"spawn_agent","taskDescription":"poll github","confidence":0.8}\n```');
    expect(c.action).toBe("spawn_agent");
    expect(c.taskDescription).toBe("poll github");
  });

  test("manage_cancel is accepted and carries a targetHint", () => {
    const c = parseClassification('{"action":"manage_cancel","targetHint":"2026","confidence":0.95}');
    expect(c.action).toBe("manage_cancel");
    expect(c.targetHint).toBe("2026");
    expect(c.targetAgentId).toBeUndefined();
  });

  test("manage_cancel strips any bogus targetAgentId (no retarget on cancel)", () => {
    const c = parseClassification('{"action":"manage_cancel","targetAgentId":"agent-2026","confidence":0.9}');
    expect(c.action).toBe("manage_cancel");
    expect(c.targetAgentId).toBeUndefined();
  });

  test("manage_list and ask_clarification are accepted", () => {
    expect(parseClassification('{"action":"manage_list","confidence":0.8}').action).toBe("manage_list");
    expect(parseClassification('{"action":"ask_clarification","confidence":0.7}').action).toBe("ask_clarification");
  });

  test("one_shot is accepted with no targetAgentId (one-time run, not a spawn)", () => {
    const c = parseClassification('{"action":"one_shot","confidence":0.85}');
    expect(c.action).toBe("one_shot");
    expect(c.targetAgentId).toBeUndefined();
  });

  test("one_shot strips any bogus targetAgentId (never retargets an agent)", () => {
    const c = parseClassification('{"action":"one_shot","targetAgentId":"agent-2026","confidence":0.9}');
    expect(c.action).toBe("one_shot");
    expect(c.targetAgentId).toBeUndefined();
  });

  test("one_shot with confidence below 0.5 forces answer_directly (no tool delegation on a guess)", () => {
    expect(parseClassification('{"action":"one_shot","confidence":0.4}')).toEqual(ANSWER_DIRECTLY);
  });

  test("ask_clarification with confidence below 0.5 forces answer_directly (spec 4.2.2)", () => {
    expect(parseClassification('{"action":"ask_clarification","confidence":0.4}')).toEqual(ANSWER_DIRECTLY);
    expect(parseClassification('{"action":"ask_clarification","confidence":0.0}')).toEqual(ANSWER_DIRECTLY);
  });

  test("ask_clarification at exactly 0.5 is accepted", () => {
    expect(parseClassification('{"action":"ask_clarification","confidence":0.5}').action).toBe("ask_clarification");
  });

  test("unknown action falls back to answer_directly", () => {
    expect(parseClassification('{"action":"fly_to_moon","confidence":0.9}')).toEqual(ANSWER_DIRECTLY);
  });
});

describe("rewrite stage (context resolution)", () => {
  test("parseRewrite extracts the rewritten query", () => {
    expect(parseRewrite('{"rewritten":"look up Headroom AI made by a Netflix engineer"}', "fallback")).toBe(
      "look up Headroom AI made by a Netflix engineer",
    );
  });

  test("parseRewrite falls back on garbage", () => {
    expect(parseRewrite("this is not json", "raw")).toBe("raw");
    expect(parseRewrite('{"rewritten":""}', "raw")).toBe("raw");
  });

  test("rewriteHistoryContext renders chronological turns and includes all small turns", () => {
    const turns = [
      { role: "user" as const, content: "first message" },
      { role: "assistant" as const, content: "a reply" },
      { role: "user" as const, content: "latest message" },
    ];
    const ctx = rewriteHistoryContext(turns);
    // Chronological (oldest -> newest) is the natural reading order.
    expect(ctx.indexOf("first message")).toBeLessThan(ctx.indexOf("latest message"));
    expect(ctx).toContain("Assistant: a reply");
  });

  test("rewriteHistoryContext returns a sentinel for empty history", () => {
    expect(rewriteHistoryContext([])).toBe("(no prior conversation)");
  });
});

describe("isPureGreeting (rewrite guard)", () => {
  test("bare greetings are detected", () => {
    expect(isPureGreeting("yo yo wassup")).toBe(true);
    expect(isPureGreeting("hey")).toBe(true);
    expect(isPureGreeting("sup")).toBe(true);
    expect(isPureGreeting("what's up")).toBe(true);
    expect(isPureGreeting("hi how are you")).toBe(true);
    expect(isPureGreeting("good morning")).toBe(true);
  });

  test("messages with actionable content are not treated as greetings", () => {
    expect(isPureGreeting("yo yo wassup, can you look up the bitcoin price?")).toBe(false);
    expect(isPureGreeting("hey watch my inbox for alice")).toBe(false);
    expect(isPureGreeting("what's up with my 2026 watch")).toBe(false);
    expect(isPureGreeting("ok")).toBe(false);
    expect(isPureGreeting("")).toBe(false);
  });
});

describe("pgvector dedup query", () => {
  const userId = `dedup-user-${Date.now()}`;
  const agentId = `dedup-agent-${Date.now()}`;
  // Two 1536-dim vectors (matches the column). Same-direction vector => similarity
  // ~0.99, even/odd-complementary => ~0.
  const dim = 1536;
  const vecA = Array.from({ length: dim }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const vecA2 = Array.from({ length: dim }, (_, i) => (i % 2 === 0 ? 0.9 : 0.1));
  const vecB = Array.from({ length: dim }, (_, i) => (i % 2 === 0 ? 0 : 1));

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" },
    });
    const conv = await prisma.conversation.create({ data: { userId } });
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        ownerConversationId: conv.id,
        taskDescription: "check email from Alice",
        status: "active",
      },
    });
    await prisma.$executeRaw`UPDATE "Agent" SET embedding = ${`[${vecA.join(",")}]`}::vector WHERE id = ${agentId}`;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  test("near-identical vector matches the active agent", async () => {
    const hit = await findDuplicateByVector(userId, vecA2);
    expect(hit?.id).toBe(agentId);
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.85);
  });

  test("orthogonal vector does not match", async () => {
    expect(await findDuplicateByVector(userId, vecB)).toBeNull();
  });

  test("dormant agents are excluded from dedup candidates", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { status: "dormant" } });
    expect(await findDuplicateByVector(userId, vecA)).toBeNull();
    await prisma.agent.update({ where: { id: agentId }, data: { status: "active" } });
  });
});

describe("archiveAgents (cancel matching)", () => {
  const userId = `archive-user-${Date.now()}`;
  const aliceId = `archive-alice-${Date.now()}`;
  const w2026Id = `archive-2026-${Date.now()}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
    const conv = await prisma.conversation.create({ data: { userId } });
    await prisma.agent.create({
      data: { id: aliceId, userId, ownerConversationId: conv.id, taskDescription: "Watch my email for messages from Alice and notify me", status: "active" },
    });
    await prisma.agent.create({
      data: { id: w2026Id, userId, ownerConversationId: conv.id, taskDescription: "Watch for check-ins or mentions related to 2026", status: "active" },
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  const status = async (id: string) => (await prisma.agent.findUnique({ where: { id } }))?.status;
  const reactivate = async () => prisma.agent.updateMany({ where: { userId }, data: { status: "active" } });
  beforeEach(async () => {
    await reactivate();
  });

  test("a paraphrased hint 'the alice watch' archives only the alice watch", async () => {
    const { archived } = await archiveAgents(userId, "the alice watch");
    expect(archived).toEqual([aliceId]);
    expect(await status(aliceId)).toBe("archived");
    expect(await status(w2026Id)).toBe("active");
  });

  test("'2026 watch' archives only the 2026 watch", async () => {
    const { archived } = await archiveAgents(userId, "2026 watch");
    expect(archived).toEqual([w2026Id]);
    expect(await status(w2026Id)).toBe("archived");
    expect(await status(aliceId)).toBe("active");
  });

  test("a generic hint 'all monitoring' cancels everything, never a silent no-op", async () => {
    const { archived } = await archiveAgents(userId, "all monitoring");
    expect(archived.sort()).toEqual([aliceId, w2026Id].sort());
  });

  test("an unmatched specific hint archives nothing (no cancel-all foot-gun)", async () => {
    const { archived } = await archiveAgents(userId, "nothing matching this");
    expect(archived).toEqual([]);
    expect(await status(aliceId)).toBe("active");
    expect(await status(w2026Id)).toBe("active");
  });

  test("a blanket verb-only hint 'stop everything' cancels all", async () => {
    const { archived } = await archiveAgents(userId, "stop everything");
    expect(archived.sort()).toEqual([aliceId, w2026Id].sort());
  });

  test("a plural blanket hint 'stop all my watches' cancels all", async () => {
    const { archived } = await archiveAgents(userId, "stop all my watches");
    expect(archived.sort()).toEqual([aliceId, w2026Id].sort());
  });

  test("empty hint cancels everything", async () => {
    const { archived } = await archiveAgents(userId);
    expect(archived.sort()).toEqual([aliceId, w2026Id].sort());
  });
});
