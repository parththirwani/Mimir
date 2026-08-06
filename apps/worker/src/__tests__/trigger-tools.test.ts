import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "trigger-tools-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { triggerTools } = await import("../agent/trigger-tools.js");

const prisma = getPrismaClient();
const userId = `ttools-${randomUUID()}`;
const convId = `ttools-conv-${randomUUID()}`;
const agentA = `ttools-A-${randomUUID()}`;
const agentB = `ttools-B-${randomUUID()}`;

let createdId: string;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
  await prisma.agent.createMany({
    data: [
      { id: agentA, userId, ownerConversationId: convId, taskDescription: "A" },
      { id: agentB, userId, ownerConversationId: convId, taskDescription: "B" },
    ],
  });
});

afterAll(async () => {
  await prisma.trigger.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.delete({ where: { id: userId } });
});

const byName = (n: string) => triggerTools().find((t) => t.name === n)!;

describe("trigger CRUD tools (4.11.3)", () => {
  test("create_trigger + list_triggers are scoped to the calling agent", async () => {
    const created = (await byName("create_trigger").execute({ name: "urgent", criteria: "urgent email from Alice" }, { userId, agentId: agentA })) as { id: string };
    createdId = created.id;
    expect(created.id).toBeTruthy();

    const listedA = (await byName("list_triggers").execute({}, { userId, agentId: agentA })) as { triggers: unknown[] };
    expect(listedA.triggers).toHaveLength(1);

    // Agent B sees none of A's triggers.
    const listedB = (await byName("list_triggers").execute({}, { userId, agentId: agentB })) as { triggers: unknown[] };
    expect(listedB.triggers).toHaveLength(0);
  });

  test("update_trigger refuses to act on another agent's trigger", async () => {
    await expect(
      byName("update_trigger").execute({ triggerId: createdId, criteria: "HACK" }, { userId, agentId: agentB }),
    ).rejects.toThrow("not found");
  });

  test("cancel_trigger disables by id", async () => {
    const res = (await byName("cancel_trigger").execute({ triggerId: createdId }, { userId, agentId: agentA })) as { cancelled: number };
    expect(res.cancelled).toBe(1);
    const t = await prisma.trigger.findUnique({ where: { id: createdId } });
    expect(t?.enabled).toBe(false);
  });
});
