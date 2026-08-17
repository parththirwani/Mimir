import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

// agent-execution.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "one-shot-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { executeOnce, findOneShotSurfaced, oneShotMessageKey, runToolLoop } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `one-shot-${randomUUID()}`;
const email = `${userId}@test.local`;

let conversationId: string;

const baseUsage = { totalTokens: 5, promptTokens: 3, completionTokens: 2 };

// A caller that returns a plain answer for execution and a distinct "FRAMED"
// line for the surface/framing call — lets the test assert which stage ran
// without any real LLM. useCase echoes the request options through.
const plainCaller = async (_messages: unknown, options?: { useCase?: string }) => {
  if (options?.useCase === "surface") {
    return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
  }
  return { content: "RAW ANSWER", model: "exec-model", actualModel: "exec-model-2", latencyMs: 5, usage: baseUsage };
};

function job(jobId: string) {
  return { id: jobId, data: { userId, conversationId, content: "check today's gold price" } } as unknown as Parameters<typeof executeOnce>[0];
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("oneShotMessageKey / findOneShotSurfaced (retry-safety primitives)", () => {
  test("the key is deterministic, namespaced, and collision-proof against client UUIDs", () => {
    expect(oneShotMessageKey("job-1")).toBe("one-shot:job-1");
    expect(oneShotMessageKey("job-1")).toBe(oneShotMessageKey("job-1"));
    expect(oneShotMessageKey("job-1")).not.toBe(oneShotMessageKey("job-2"));
  });

  test("findOneShotSurfaced is null with no prior write, the message once a keyed message exists", async () => {
    const jobId = `job-${randomUUID()}`;
    expect(await findOneShotSurfaced(conversationId, jobId)).toBeNull();
    await prisma.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: "prior attempt",
        status: "complete",
        clientMessageId: oneShotMessageKey(jobId),
      },
    });
    expect(await findOneShotSurfaced(conversationId, jobId)).not.toBeNull();
  });
});

describe("executeOnce (one-shot execution with NO Agent row)", () => {
  test("surfaces a framed answer as a message and creates NO Agent", async () => {
    const jobId = `job-${randomUUID()}`;
    await executeOnce(job(jobId), { caller: plainCaller });

    const msg = await prisma.message.findFirst({
      where: { conversationId, clientMessageId: oneShotMessageKey(jobId) },
    });
    expect(msg).toBeDefined();
    expect(msg?.content).toBe("FRAMED");
    expect(await prisma.agent.count({ where: { userId } })).toBe(0);
  });

  test("a retry after a post-write crash short-circuits: no second surfaced answer", async () => {
    const jobId = `job-${randomUUID()}`;
    // Simulate the first attempt's crash state: the surfaced message was written
    // (with the job-scoped clientMessageId) but the job never resolved, so BullMQ
    // retries it. If the retry re-ran the tool loop, the user would see a second
    // copy — exactly the symptom this check exists to prevent.
    await prisma.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: "first attempt answer",
        status: "complete",
        clientMessageId: oneShotMessageKey(jobId),
      },
    });

    let calls = 0;
    const countingCaller = async (...args: Parameters<typeof plainCaller>) => {
      calls += 1;
      return plainCaller(...args);
    };

    await executeOnce(job(jobId), { caller: countingCaller });

    expect(calls).toBe(0); // short-circuited BEFORE any LLM call
    const msgs = await prisma.message.findMany({ where: { conversationId, clientMessageId: oneShotMessageKey(jobId) } });
    expect(msgs).toHaveLength(1); // still exactly one surfaced answer
    expect(await prisma.agent.count({ where: { userId } })).toBe(0);
  });

  test("a one-shot run that calls wait surfaces nothing and creates no message", async () => {
    const waitCaller = async () => ({
      content: "",
      model: "m",
      latencyMs: 1,
      usage: baseUsage,
      toolCalls: [{ id: "tc-1", type: "function", function: { name: "wait", arguments: "{}" } }],
    });
    const jobId = `job-${randomUUID()}`;
    await executeOnce(job(jobId), { caller: waitCaller });

    const msgs = await prisma.message.findMany({ where: { conversationId, clientMessageId: oneShotMessageKey(jobId) } });
    expect(msgs).toHaveLength(0);
    expect(await prisma.agent.count({ where: { userId } })).toBe(0);
  });
});

describe("runToolLoop (shared loop)", () => {
  test("executes a registered task and re-calls the model with the tool result appended", async () => {
    const executed: unknown[] = [];
    const seenMessages: { role: string; content: string }[][] = [];
    const fakeTask = {
      kind: "task" as const,
      name: "lookup_price",
      description: "look up the price",
      inputSchema: { type: "object", properties: {} },
      async execute(input: unknown) {
        executed.push(input);
        return { price: 100 };
      },
    };
    let calls = 0;
    const caller = async (messages: unknown[]) => {
      seenMessages.push(messages as { role: string; content: string }[]);
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          model: "m",
          latencyMs: 1,
          usage: baseUsage,
          toolCalls: [{ id: "tc-1", type: "function", function: { name: "lookup_price", arguments: "{}" } }],
        };
      }
      return { content: "final", model: "m", latencyMs: 1, usage: baseUsage };
    };

    const outcome = await runToolLoop(
      { messages: [{ role: "user", content: "q" }], tools: [], userId, availableTasks: [fakeTask] },
      async () => ({ handled: false }),
      caller,
    );

    expect(calls).toBe(2);
    expect(executed).toHaveLength(1);
    expect(outcome).toMatchObject({ result: { content: "final" } });
    const secondTurn = seenMessages[1];
    expect(secondTurn?.some((m) => m.role === "tool" && m.content.includes('"price":100'))).toBe(true);
  });

  test("stops immediately on a terminal wait tool and reports stopped", async () => {
    const caller = async () => ({
      content: "",
      model: "m",
      latencyMs: 1,
      usage: baseUsage,
      toolCalls: [{ id: "tc-1", type: "function", function: { name: "wait", arguments: "{}" } }],
    });
    const outcome = await runToolLoop(
      { messages: [{ role: "user", content: "q" }], tools: [], userId, availableTasks: [] },
      async (name) => (name === "wait" ? { handled: true, stopped: "wait" as const } : { handled: false }),
      caller,
    );
    expect(outcome).toEqual({ stopped: "wait" });
  });
});
