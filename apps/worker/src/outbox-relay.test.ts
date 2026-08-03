import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "outbox-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { drainOutbox } = await import("./outbox-relay.js");

const prisma = getPrismaClient();
// Own connection so this file's afterAll doesn't fight queues.test.ts's singletons.
const agentJobs = new Queue("agent-jobs", {
  connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
});

const agentId = `test-agent-${Date.now()}`;
const userId = `outbox-test-user-${Date.now()}`;
const convId = `outbox-test-conv-${Date.now()}`;

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" },
  });
  await prisma.conversation.create({ data: { id: convId, userId } });
  await prisma.agent.create({
    data: { id: agentId, userId, ownerConversationId: convId, taskDescription: "test task" },
  });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["agentId"], equals: agentId } } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.delete({ where: { id: userId } });
  await agentJobs.close();
});

async function poll<T>(fn: () => Promise<T>, ok: (t: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await Bun.sleep(50);
  }
}

describe("outbox relay (Plan 4.4.3)", () => {
  test("an unprocessed OutboxEvent row is enqueued to agent-jobs and marked processed", async () => {
    const row = await prisma.outboxEvent.create({
      data: { eventType: "spawn_agent", payload: { agentId, trigger: "user_message" } },
    });

    const enqueued = await drainOutbox(agentJobs);

    expect(enqueued).toBe(1);
    await poll(
      () => prisma.outboxEvent.findUnique({ where: { id: row.id } }),
      (r) => r?.processedAt != null,
    );
    const job = await agentJobs.getJob(`outbox-${row.id}`);
    expect(job?.data).toMatchObject({ agentId, trigger: "user_message" });
  });

  test("a row without agentId is skipped and marked processed (no crash-loop)", async () => {
    const row = await prisma.outboxEvent.create({
      data: { eventType: "unknown", payload: { foo: "bar" } },
    });

    const enqueued = await drainOutbox(agentJobs);

    expect(enqueued).toBe(0);
    const after = await prisma.outboxEvent.findUnique({ where: { id: row.id } });
    expect(after?.processedAt).not.toBeNull();
  });
});
