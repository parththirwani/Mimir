import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "surfaced-dedup-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { isDuplicateSurface } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `dup-${randomUUID()}`;
const convId = `dup-conv-${randomUUID()}`;
const agentId = `dup-agent-${randomUUID()}`;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
  await prisma.agent.create({ data: { id: agentId, userId, ownerConversationId: convId, taskDescription: "t" } });
});

afterAll(async () => {
  await prisma.agentEvent.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("isDuplicateSurface (cross-path dedup)", () => {
  test("no surfaced event yet -> not a duplicate", async () => {
    expect(await isDuplicateSurface(agentId, "anything")).toBe(false);
  });

  test("identical content to the last surfaced event -> duplicate", async () => {
    await prisma.agentEvent.create({ data: { agentId, eventType: "surfaced", payload: { content: "Alice confirmed lunch" } } });
    expect(await isDuplicateSurface(agentId, "Alice confirmed lunch")).toBe(true);
  });

  test("different content is surfaced fresh", async () => {
    expect(await isDuplicateSurface(agentId, "Bob pushed the deploy")).toBe(false);
  });

  test("a discarded event is ignored (only surfaces count)", async () => {
    await prisma.agentEvent.create({ data: { agentId, eventType: "discarded", payload: { content: "Bob pushed the deploy" } } });
    expect(await isDuplicateSurface(agentId, "Bob pushed the deploy")).toBe(false);
  });
});
