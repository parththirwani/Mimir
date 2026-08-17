import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "reactivation-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { executeAgent } = await import("../agent/agent-execution.js");
const { runTriggerSweep } = await import("../agent/triggers.js");

const prisma = getPrismaClient();
const userId = `react-${randomUUID()}`;
const email = `${userId}@test.local`;
const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };

let conversationId: string;
let triggerOwnerId: string;

const baseUsage = { totalTokens: 5, promptTokens: 3, completionTokens: 2 };

// Fake LLM: a plain "RAW" answer for the execution loop and a distinct "FRAMED"
// line for the surface/framing call. useCase disambiguates which stage ran.
const fakeCaller = async (_messages: unknown, options?: { useCase?: string }) => {
  if (options?.useCase === "surface") {
    return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
  }
  return { content: "RAW", model: "exec-model", actualModel: "exec-model-2", latencyMs: 5, usage: baseUsage };
};

async function spawnResearchAgent(): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      userId,
      ownerConversationId: conversationId,
      taskDescription: "research what Graphify does",
      entity: "browser",
    },
  });
  return agent.id;
}

// Six simulated poll-equivalent ticks (the deleted poller re-ran every active
// agent roughly every 2 minutes and kept going for ~11 minutes). The only
// scheduled enqueuer left is the trigger sweep, so a tick IS a sweep run whose
// judge fires triggers normally — and must still never touch a trigger-less agent.
const TICKS = 6;
async function runPollEquivalentTicks(queue: Queue): Promise<void> {
  for (let tick = 1; tick <= TICKS; tick++) {
    await runTriggerSweep({
      evaluate: async ({ agentId: a }: { agentId?: string }) => ({
        matches: a === triggerOwnerId,
        rationale: "scoped verdict",
      }),
      queue,
    });
  }
}

const agentJobIds = async (q: Queue): Promise<string[]> =>
  (await q.getJobs(["waiting", "delayed", "active"]))
    .map((j) => (j.data as { agentId?: string }).agentId)
    .filter((a): a is string => a != null);

function execJob(agentId: string) {
  return {
    id: `react-exec-${agentId}`,
    data: { agentId, trigger: "user_message" },
  } as Parameters<typeof executeAgent>[0];
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
  const owner = await prisma.agent.create({
    data: { userId, ownerConversationId: conversationId, taskDescription: "watch for urgent email" },
  });
  triggerOwnerId = owner.id;
  await prisma.trigger.create({
    data: { agentId: owner.id, name: "urgent mail", criteria: "an urgent email arrives" },
  });
});

afterAll(async () => {
  await prisma.trigger.deleteMany({ where: { agent: { userId } } });
  await prisma.agentEvent.deleteMany({ where: { agent: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("direct repro: Graphify incident (7 duplicate answers)", () => {
  test("a browser-entity agent surfaces ONCE after execution + 6 poll-equivalent ticks — never 7", async () => {
    const agentId = await spawnResearchAgent();
    const queue = new Queue(`react-graphify-${Date.now()}`, { connection });
    const msgsBefore = await prisma.message.count({ where: { conversationId } });

    // The one legitimate execution (a user message).
    await executeAgent(execJob(agentId), { caller: fakeCaller });
    expect(await prisma.agentEvent.count({ where: { agentId, eventType: "surfaced" } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } }) - msgsBefore).toBe(1);

    // Six more poll-equivalent ticks — the deleted poller's 11-minute exposure.
    await runPollEquivalentTicks(queue);

    expect(await prisma.agentEvent.count({ where: { agentId, eventType: "surfaced" } })).toBe(1);
    expect(await prisma.agentEvent.count({ where: { agentId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } }) - msgsBefore).toBe(1);
    // And at the queue level: zero jobs for this agent across all six ticks.
    expect(await agentJobIds(queue)).not.toContain(agentId);
    await queue.close();
  });

  test("the agent is never invoked a second time with empty fetchEntityData (fabrication path gone)", async () => {
    const agentId = await spawnResearchAgent();
    const queue = new Queue(`react-karpathy-${Date.now()}`, { connection });
    const msgsBefore = await prisma.message.count({ where: { conversationId } });

    await executeAgent(execJob(agentId), { caller: fakeCaller });
    await runPollEquivalentTicks(queue);

    // Execution count stayed at EXACTLY one: any second invocation (even one that
    // surfaced nothing) writes >=1 AgentEvent, so this is a hard upper bound on
    // re-invocation. A re-run fed empty browser data is what fabricated the link
    // in the original incident — there is no longer any tick that can reach it.
    expect(await prisma.agentEvent.count({ where: { agentId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } }) - msgsBefore).toBe(1);

    // Structural guarantee: the poller module is gone from the module graph — it
    // cannot even be imported, so no code path can enqueue a `trigger:"poll"` job.
    // (Path is built at runtime so tsc doesn't try to resolve the deleted file.)
    const deletedPollerPath = "../infra/event-polling" + ".js";
    await expect(import(deletedPollerPath)).rejects.toThrow();
    expect(await agentJobIds(queue)).not.toContain(agentId);
    await queue.close();
  });
});