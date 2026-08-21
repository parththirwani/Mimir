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
    data: {
      id: agentId,
      userId,
      ownerConversationId: convId,
      taskDescription: "test task",
    },
  });
});

afterAll(async () => {
  for (const id of enqueuedJobIds) {
    const [agentJob, emailJob] = await Promise.all([
      agentJobs.getJob(id),
      emailJobs.getJob(id),
    ]);
    await agentJob?.remove();
    await emailJob?.remove();
  }
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.outboxEvent.deleteMany({
    where: { payload: { path: ["agentId"], equals: agentId } },
  });
  await prisma.outboxEvent.deleteMany({ where: { eventType: "email_send" } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.delete({ where: { id: userId } });
  await agentJobs.close();
  await emailJobs.close();
});

async function poll<T>(
  fn: () => Promise<T>,
  ok: (t: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
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
      data: {
        eventType: "spawn_agent",
        payload: { agentId, trigger: "user_message" },
      },
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
    const after = await prisma.outboxEvent.findUnique({
      where: { id: row.id },
    });
    expect(after?.processedAt).not.toBeNull();
  });

  test("an enqueue failure mid-spawn leaves the row unprocessed; a later relay recovers it", async () => {
    // 4.4.4 "kill Redis mid-spawn": the OutboxEvent row is durable in Postgres,
    // but the BullMQ enqueue (Redis) fails. The row must survive unprocessed and
    // be drained once Redis is healthy — nothing is lost.
    const row = await prisma.outboxEvent.create({
      data: {
        eventType: "spawn_agent",
        payload: { agentId, trigger: "user_message" },
      },
    });

    const broken = {
      add: async () => {
        throw new Error("redis down (simulated)");
      },
    } as unknown as Parameters<typeof drainOutbox>[0];
    const enqueuedDown = await drainOutbox(broken);

    expect(enqueuedDown).toBe(0);
    expect(
      (await prisma.outboxEvent.findUnique({ where: { id: row.id } }))
        ?.processedAt,
    ).toBeNull();

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
    const payload = {
      userId,
      conversationId: convId,
      content: "use the browser to check today's gold price",
    };
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

  test("extract_facts coalescing: SAME window -> ONE job; a LATER window still gets a fresh job (no permanent jobId block)", async () => {
    const factQueue = new Queue(`fact-${Date.now()}`, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    const onceQueue = new Queue(`once-co-${Date.now()}`, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    const conv = await prisma.conversation.create({
      data: { id: `co-single-${Date.now()}`, userId },
    });
    const base = Date.now() - 120_000;
    // Same minute for both -> same windowed jobId -> coalesce into ONE job.
    const payload = {
      conversationId: conv.id,
      userId,
      windowEnd: new Date(base).toISOString(),
    };
    const r1 = await prisma.outboxEvent.create({
      data: { eventType: "extract_facts", payload },
    });
    const r2 = await prisma.outboxEvent.create({
      data: { eventType: "extract_facts", payload },
    });

    await drainOutbox(agentJobs, emailJobs, onceQueue, factQueue);

    await poll(
      () =>
        prisma.outboxEvent.count({
          where: { id: { in: [r1.id, r2.id] }, processedAt: { not: null } },
        }),
      (c) => c === 2,
    );
    const jobId = `fact-${conv.id}-${Math.floor(base / 60_000)}`;
    expect(await factQueue.getJob(jobId)).toBeTruthy();
    expect(
      (await factQueue.getJobs(["waiting", "active", "delayed"])).filter(
        (j) => j.id === jobId,
      ).length,
    ).toBe(1);
    await factQueue.getJob(jobId).then((j) => j?.remove());

    // Later window (next minute) for the SAME conversation -> a DIFFERENT jobId,
    // so a second burst AFTER the first completed still gets a fresh job. This is
    // the regression the static `fact-<conversationId>` key would have hit (it
    // would block forever on the completed job's retained ID).
    const payload2 = {
      conversationId: conv.id,
      userId,
      windowEnd: new Date(base + 60_000).toISOString(),
    };
    const r3 = await prisma.outboxEvent.create({
      data: { eventType: "extract_facts", payload: payload2 },
    });
    await drainOutbox(agentJobs, emailJobs, onceQueue, factQueue);
    await poll(
      () =>
        prisma.outboxEvent.count({
          where: { id: { in: [r3.id] }, processedAt: { not: null } },
        }),
      (c) => c === 1,
    );
    const jobId2 = `fact-${conv.id}-${Math.floor((base + 60_000) / 60_000)}`;
    expect(jobId2).not.toBe(jobId);
    const job2 = await factQueue.getJob(jobId2);
    expect(job2).toBeTruthy();
    await job2?.remove();

    await factQueue.close();
    await onceQueue.close();
    await prisma.outboxEvent.deleteMany({
      where: { id: { in: [r1.id, r2.id, r3.id] } },
    });
    await prisma.conversation.delete({ where: { id: conv.id } });
  });
});
