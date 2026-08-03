import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// agent.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "agent-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ANSWER_DIRECTLY, findDuplicateByVector, parseClassification } = await import("./agent.js");

const prisma = getPrismaClient();

describe("parseClassification (Plan 4.2.2)", () => {
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
});

describe("pgvector dedup query (Plan 4.3.2)", () => {
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
