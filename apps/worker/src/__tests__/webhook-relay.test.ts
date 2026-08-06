import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "webhook-relay-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { drainWebhookEvents } = await import("../infra/webhook-relay.js");

const prisma = getPrismaClient();
const q = new Queue("agent-jobs", { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } });

const userId = `wh-relay-${randomUUID()}`;
const convId = `wh-relay-conv-${randomUUID()}`;
const gmailAgentId = `wh-relay-gmail-${randomUUID()}`;
const browserAgentId = `wh-relay-browser-${randomUUID()}`;
const enqueuedJobIds: string[] = [];

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
  // One gmail-entity agent (entity fan-out should hit it) and one browser agent
  // (a gmail webhook must NOT wake it) + one dormant gmail agent (excluded).
  await prisma.agent.createMany({
    data: [
      { id: gmailAgentId, userId, ownerConversationId: convId, taskDescription: "watch gmail", entity: "gmail", status: "active" },
      { id: browserAgentId, userId, ownerConversationId: convId, taskDescription: "watch web", entity: "browser", status: "active" },
      { id: `${gmailAgentId}-dorm`, userId, ownerConversationId: convId, taskDescription: "dormant gmail", entity: "gmail", status: "dormant" },
    ],
  });
});

afterAll(async () => {
  for (const id of enqueuedJobIds) await q.getJob(id).then((j) => j?.remove());
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.webhookEvent.deleteMany({ where: { rawPayload: { path: ["__test"], equals: userId } } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await q.close();
});

describe("webhook relay (6.1.4 entity fan-out)", () => {
  test("fans a gmail webhook out to active gmail-entity TASK agents only, then marks processed", async () => {
    const row = await prisma.webhookEvent.create({
      data: { provider: "gmail", externalId: `h-${randomUUID()}`, rawPayload: { historyId: "123", __test: userId } },
    });

    const processed = await drainWebhookEvents(q);

    expect(processed).toBe(1);
    const updated = await prisma.webhookEvent.findUnique({ where: { id: row.id } });
    expect(updated?.processedAt).not.toBeNull();

    // Browser agent and dormant gmail agent were NOT enqueued.
    const jobA = await q.getJob(`webhook-${row.id}-${gmailAgentId}`);
    const jobB = await q.getJob(`webhook-${row.id}-${browserAgentId}`);
    const jobD = await q.getJob(`webhook-${row.id}-${gmailAgentId}-dorm`);
    enqueuedJobIds.push(`webhook-${row.id}-${gmailAgentId}`);
    expect(jobA?.data).toMatchObject({ agentId: gmailAgentId, trigger: "webhook" });
    expect(jobB ?? null).toBeNull();
    expect(jobD ?? null).toBeNull();
  });

  test("a webhook matching no agents is still marked processed (no crash-loop)", async () => {
    const row = await prisma.webhookEvent.create({
      data: { provider: "slack", externalId: `e-${randomUUID()}`, rawPayload: { event_id: "x", __test: userId } },
    });
    const processed = await drainWebhookEvents(q);
    expect(processed).toBe(1);
    const updated = await prisma.webhookEvent.findUnique({ where: { id: row.id } });
    expect(updated?.processedAt).not.toBeNull();
  });
});
