import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "outbox-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { drainOutbox } = await import("../infra/outbox-relay.js");

const prisma = getPrismaClient();
// Own connections so this file's afterAll doesn't fight queues.test.ts's singletons.
const agentJobs = new Queue("agent-jobs", {
  connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
});
const emailJobs = new Queue("email-jobs", {
  connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
});

const agentId = `test-agent-${Date.now()}`;
const userId = `outbox-test-user-${Date.now()}`;
const convId = `outbox-test-conv-${Date.now()}`;
// The dev worker owns the real agent-jobs/email-jobs queues (shared Redis), so
// a job enqueued here and left behind gets drained by the running worker against
// already-deleted test data. Track what we enqueue and remove it in afterAll.
const enqueuedJobIds: string[] = [];

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
  for (const id of enqueuedJobIds) {
    const [agentJob, emailJob] = await Promise.all([agentJobs.getJob(id), emailJobs.getJob(id)]);
    await agentJob?.remove();
    await emailJob?.remove();
  }
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["agentId"], equals: agentId } } });
  await prisma.outboxEvent.deleteMany({ where: { eventType: "email_send" } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.delete({ where: { id: userId } });
  await agentJobs.close();
  await emailJobs.close();
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

describe("outbox relay", () => {
  test("an unprocessed OutboxEvent row is enqueued to agent-jobs and marked processed", async () => {
    const row = await prisma.outboxEvent.create({
      data: { eventType: "spawn_agent", payload: { agentId, trigger: "user_message" } },
    });

    const enqueued = await drainOutbox(agentJobs);

    expect(enqueued).toBe(1);
    enqueuedJobIds.push(`outbox-${row.id}`);
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

  test("an enqueue failure mid-spawn leaves the row unprocessed; a later relay recovers it", async () => {
    // 4.4.4 "kill Redis mid-spawn": the OutboxEvent row is durable in Postgres,
    // but the BullMQ enqueue (Redis) fails. The row must survive unprocessed and
    // be drained once Redis is healthy — nothing is lost.
    const row = await prisma.outboxEvent.create({
      data: { eventType: "spawn_agent", payload: { agentId, trigger: "user_message" } },
    });

    const broken = { add: async () => { throw new Error("redis down (simulated)"); } } as unknown as Parameters<typeof drainOutbox>[0];
    const enqueuedDown = await drainOutbox(broken);

    expect(enqueuedDown).toBe(0);
    expect((await prisma.outboxEvent.findUnique({ where: { id: row.id } }))?.processedAt).toBeNull();

    const enqueued = await drainOutbox(agentJobs);

    expect(enqueued).toBe(1);
    enqueuedJobIds.push(`outbox-${row.id}`);
    await poll(
      () => prisma.outboxEvent.findUnique({ where: { id: row.id } }),
      (r) => r?.processedAt != null,
    );
    const job = await agentJobs.getJob(`outbox-${row.id}`);
    expect(job?.data).toMatchObject({ agentId, trigger: "user_message" });
  });

  test("an email_send row is routed to email-jobs and marked processed", async () => {
    const payload = {
      userId,
      draftId: "draft-1",
      messageId: "msg-1",
      conversationId: convId,
      to: "alice@example.com",
      subject: "Hi",
      parentMessageId: "parent-1",
    };
    const row = await prisma.outboxEvent.create({
      data: { eventType: "email_send", payload },
    });

    const enqueued = await drainOutbox(agentJobs, emailJobs);

    expect(enqueued).toBe(1);
    enqueuedJobIds.push(`outbox-${row.id}`);
    await poll(
      () => prisma.outboxEvent.findUnique({ where: { id: row.id } }),
      (r) => r?.processedAt != null,
    );
    const job = await emailJobs.getJob(`outbox-${row.id}`);
    expect(job?.data).toMatchObject(payload);
  });

  test("a one_shot row (no agentId) is routed to agent-once and marked processed", async () => {
    // Throwaway queue name: queues.test.ts's startWorkers() registers a worker on
    // the real "agent-once" queue in the SAME test process, which would lock the
    // job and race the cleanup below. A unique name has no consumer.
    const onceJobs = new Queue(`once-${Date.now()}`, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    const payload = { userId, conversationId: convId, content: "use the browser to check today's gold price" };
    const row = await prisma.outboxEvent.create({
      data: { eventType: "one_shot", payload },
    });

    const enqueued = await drainOutbox(agentJobs, emailJobs, onceJobs);

    expect(enqueued).toBe(1);
    await poll(
      () => prisma.outboxEvent.findUnique({ where: { id: row.id } }),
      (r) => r?.processedAt != null,
    );
    const job = await onceJobs.getJob(`outbox-${row.id}`);
    expect(job?.data).toMatchObject(payload);
    await job?.remove();
    await onceJobs.close();
  });
});
