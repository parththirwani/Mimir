import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LlmMessage } from "@mimir/shared-types";

// reflector.ts / agent-execution.ts load prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "reflector-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { evaluateTask, parseReflectionVerdict, reflectionFeedbackMessage, reflectRun } = await import("../agent/reflector.js");
const { executeAgent, executeOnce, oneShotMessageKey } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `reflect-${randomUUID()}`;
const convId = `reflect-conv-${randomUUID()}`;

const baseUsage = { totalTokens: 5, promptTokens: 3, completionTokens: 2 };
const chat = (c: string) => ({ content: c, model: "m", latencyMs: 1, usage: baseUsage });

// An injectable execution caller that sequences generator content and evaluator
// verdicts. useCase routes: agent_execution = generator, evaluation = evaluator,
// surface = framing (mirrors the real flow's three separate calls).
function flowCaller(opts: {
  gens: string[];
  verdicts: Array<{ pass: boolean; score: number; feedback: string }>;
  toolCallsFirst?: boolean;
}) {
  let genCount = 0;
  let evalCount = 0;
  let lastGenMessages: LlmMessage[] = [];
  const caller = async (messages: unknown, options?: { useCase?: string }) => {
    if (options?.useCase === "evaluation") {
      const v = opts.verdicts[Math.min(evalCount, opts.verdicts.length - 1)];
      evalCount += 1;
      return chat(JSON.stringify(v));
    }
    if (options?.useCase === "surface") return chat("FRAMED");
    lastGenMessages = messages as LlmMessage[];
    genCount += 1;
    if (opts.toolCallsFirst && genCount === 1) {
      return { content: "", model: "m", latencyMs: 1, usage: baseUsage, toolCalls: [{ id: "tc-1", type: "function", function: { name: "wait", arguments: "{}" } }] };
    }
    return chat(opts.gens[genCount - 1] ?? `ATTEMPT ${genCount}`);
  };
  return { caller, gens: () => genCount, evals: () => evalCount, lastGenMessages: () => lastGenMessages };
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
});

afterAll(async () => {
  await prisma.reflectionEvent.deleteMany({ where: { agent: { userId } } });
  await prisma.agentEvent.deleteMany({ where: { agent: { userId } } });
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.trigger.deleteMany({ where: { agent: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

async function newAgent(complexity: "simple" | "complex" = "complex", task = "book the cheapest flight under $400"): Promise<string> {
  const a = await prisma.agent.create({
    data: { id: `reflect-agent-${randomUUID()}`, userId, ownerConversationId: convId, taskDescription: task, entity: "browser", complexity },
  });
  return a.id;
}

function agentJob(agentId: string, id = `reflect-job-${randomUUID()}`) {
  return { id, data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0];
}

describe("parseReflectionVerdict", () => {
  test("parses a valid verdict", () => {
    expect(parseReflectionVerdict('{"pass":false,"score":0.3,"feedback":"missing the price"}')).toEqual({ pass: false, score: 0.3, feedback: "missing the price" });
  });

  test("accepts markdown-fenced JSON and clamps the score to 0-1", () => {
    const v = parseReflectionVerdict('```json\n{"pass": true, "score": 1.4, "feedback": "ok"}\n```');
    expect(v).toEqual({ pass: true, score: 1, feedback: "ok" });
  });

  test("rejects unparseable / wrong-shape output (fail-open upstream)", () => {
    expect(parseReflectionVerdict("sure, that looks fine!")).toBeNull();
    expect(parseReflectionVerdict('{"pass":"yes","score":0.9,"feedback":""}')).toBeNull();
    expect(parseReflectionVerdict('{"pass":false,"feedback":"no score"}')).toBeNull();
  });
});

describe("evaluateTask (fail-open)", () => {
  test("a valid verdict is returned and the call is cost-tracked", async () => {
    const verdict = await evaluateTask(userId, "task", "result", async () => chat('{"pass":false,"score":0.4,"feedback":"too vague"}'));
    expect(verdict).toEqual({ pass: false, score: 0.4, feedback: "too vague" });
    const row = await prisma.modelCallLog.findFirst({ where: { userId, useCase: "evaluation" }, orderBy: { createdAt: "desc" } });
    expect(row?.success).toBe(true);
  });

  test("a thrown evaluator call is a fail-open pass, tracked as an error", async () => {
    const flaky = async () => {
      throw new Error("evaluator 502");
    };
    const verdict = await evaluateTask(userId, "task", "result", flaky);
    expect(verdict).toEqual({ pass: true, score: 0, feedback: "evaluator error" });
    const row = await prisma.modelCallLog.findFirst({ where: { userId, useCase: "evaluation" }, orderBy: { createdAt: "desc" } });
    expect(row?.success).toBe(false);
    expect(row?.finishReason).toBe("error");
  });

  test("an unparseable verdict is a fail-open pass", async () => {
    const prose = async () => chat("I'm sorry, I can't judge that without more context.");
    const verdict = await evaluateTask(userId, "task", "result", prose);
    expect(verdict).toEqual({ pass: true, score: 0, feedback: "unparseable evaluator output" });
  });
});

describe("reflectRun (unit)", () => {
  test("fail-then-pass: retry generation receives the feedback; failed attempt recorded in retriedAttempts", async () => {
    const generations: string[] = [];
    const feedbackSeen: (string | undefined)[] = [];
    const result = await reflectRun({
      generate: async (feedback) => {
        feedbackSeen.push(feedback);
        const content = feedback ? "ATTEMPT 2" : "ATTEMPT 1";
        generations.push(content);
        return { result: chat(content) };
      },
      evaluate: async (content) => (content === "ATTEMPT 1" ? { pass: false, score: 0.3, feedback: "missing the price" } : { pass: true, score: 0.9, feedback: "good" }),
      taskDescription: "t",
      userId,
    });
    expect(result).toMatchObject({ lowConfidence: false, attempts: 2 });
    expect(result.outcome).toMatchObject({ result: { content: "ATTEMPT 2" } });
    expect(generations).toEqual(["ATTEMPT 1", "ATTEMPT 2"]);
    expect(feedbackSeen).toEqual([undefined, "missing the price"]);
    // The failed attempt that triggered the retry is surfaced for post-loop persistence.
    expect(result.retriedAttempts).toEqual([{ attempt: 1, verdict: { pass: false, score: 0.3, feedback: "missing the price" } }]);
  });

  test("exhaustion: best-scoring attempt wins, flagged low-confidence; final attempt not in retriedAttempts", async () => {
    const scores = [0.4, 0.9, 0.6];
    let attempt = 0;
    const result = await reflectRun({
      generate: async () => {
        attempt += 1;
        return { result: chat(`ATTEMPT ${attempt}`) };
      },
      evaluate: async () => ({ pass: false, score: scores[attempt - 1]!, feedback: "nope" }),
      taskDescription: "t",
      userId,
    });
    expect(result.lowConfidence).toBe(true);
    expect(result.attempts).toBe(3);
    // Attempt 2 scored highest (0.9) — that's the surfaced outcome.
    expect(result.outcome).toMatchObject({ result: { content: "ATTEMPT 2" } });
    // Attempts 1 and 2 led to retries; the exhausted 3rd is not recorded.
    expect(result.retriedAttempts.map((r) => r.attempt)).toEqual([1, 2]);
  });

  test("wait terminal outcome short-circuits with zero evaluator calls", async () => {
    let evals = 0;
    const result = await reflectRun({
      generate: async () => ({ stopped: "wait" as const }),
      evaluate: async () => {
        evals += 1;
        return { pass: true, score: 1, feedback: "" };
      },
      taskDescription: "t",
      userId,
    });
    expect(result.outcome).toEqual({ stopped: "wait" });
    expect(result.lowConfidence).toBe(false);
    expect(evals).toBe(0);
    expect(result.retriedAttempts).toEqual([]);
  });
});

describe("executeAgent — complex agent through the reflector", () => {
  test("fail-then-pass: feedback reaches the retry, ReflectionEvent written, passing attempt surfaces", async () => {
    const agentId = await newAgent("complex");
    const flow = flowCaller({
      gens: ["ATTEMPT 1", "ATTEMPT 2"],
      verdicts: [
        { pass: false, score: 0.3, feedback: "missing the price" },
        { pass: true, score: 0.9, feedback: "good" },
      ],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.gens()).toBe(2);
    expect(flow.evals()).toBe(2);
    // The retry generation sees the feedback appended as a system message.
    const retryMessages = flow.lastGenMessages();
    expect(retryMessages.some((m) => m.role === "system" && m.content === reflectionFeedbackMessage("missing the price"))).toBe(true);

    // Attempt 1's failed evaluation is recorded in ReflectionEvent only — no
    // reflection_retry AgentEvent (it would pollute loadContext's history).
    const reflections = await prisma.reflectionEvent.findMany({ where: { agentId } });
    expect(reflections).toHaveLength(1);
    expect(reflections[0]?.attemptNumber).toBe(1);
    expect(reflections[0]?.score).toBe(0.3);
    expect(reflections[0]?.feedback).toBe("missing the price");
    expect(await prisma.agentEvent.count({ where: { agentId, eventType: "reflection_retry" } })).toBe(0);

    // The passing attempt surfaces (framed) with no low-confidence flag.
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect(surfaced?.payload).toMatchObject({ content: "ATTEMPT 2" });
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toBe("FRAMED");
  });

  test("exhaustion: best-scoring attempt surfaces with lowConfidence flag + appended note; retried attempts recorded", async () => {
    const agentId = await newAgent("complex");
    const flow = flowCaller({
      gens: ["ATTEMPT 1", "ATTEMPT 2", "ATTEMPT 3"],
      verdicts: [
        { pass: false, score: 0.4, feedback: "nope 1" },
        { pass: false, score: 0.9, feedback: "nope 2" },
        { pass: false, score: 0.6, feedback: "nope 3" },
      ],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.gens()).toBe(3);
    expect(flow.evals()).toBe(3);
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    // Best-scoring attempt (2) surfaces, flagged low-confidence.
    expect(surfaced?.payload).toMatchObject({ content: "ATTEMPT 2", lowConfidence: true });
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toContain("FRAMED");
    expect(msg?.content).toContain("couldn't fully verify");
    // Attempts 1 and 2 (the retried ones) are persisted; the exhausted 3rd is not.
    const reflections = await prisma.reflectionEvent.findMany({ where: { agentId }, orderBy: { attemptNumber: "asc" } });
    expect(reflections.map((r) => r.attemptNumber)).toEqual([1, 2]);
  });

  test("wait terminal outcome short-circuits: no evaluator calls, nothing surfaces", async () => {
    const agentId = await newAgent("complex");
    const flow = flowCaller({ gens: ["x"], verdicts: [{ pass: false, score: 0, feedback: "" }], toolCallsFirst: true });
    const messagesBefore = await prisma.message.count({ where: { conversationId: convId } });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.gens()).toBe(1);
    expect(flow.evals()).toBe(0);
    expect(await prisma.agentEvent.count({ where: { agentId, eventType: "surfaced" } })).toBe(0);
    expect(await prisma.message.count({ where: { conversationId: convId } })).toBe(messagesBefore);
  });

  test("simple-complexity agent: zero evaluator calls", async () => {
    const agentId = await newAgent("simple");
    const flow = flowCaller({ gens: ["SIMPLE ANSWER"], verdicts: [{ pass: false, score: 0, feedback: "" }] });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.gens()).toBe(1);
    expect(flow.evals()).toBe(0);
    expect(await prisma.reflectionEvent.count({ where: { agentId } })).toBe(0);
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect(surfaced?.payload).toMatchObject({ content: "SIMPLE ANSWER" });
    expect((surfaced?.payload as { lowConfidence?: boolean }).lowConfidence).toBeUndefined();
  });
});

describe("executeOnce — complex one-shot through the reflector", () => {
  test("fail-then-pass surfaces the passing attempt; one-shot writes no ReflectionEvent/AgentEvent", async () => {
    const conversationId = convId;
    const flow = flowCaller({
      gens: ["ATTEMPT 1", "ATTEMPT 2"],
      verdicts: [
        { pass: false, score: 0.2, feedback: "missing units" },
        { pass: true, score: 0.95, feedback: "good" },
      ],
    });
    const jobId = `reflect-once-${randomUUID()}`;
    const reflectionsBefore = await prisma.reflectionEvent.count({ where: { agent: { userId } } });
    await executeOnce(
      { id: jobId, data: { userId, conversationId, content: "what is the gold price", complexity: "complex" } } as Parameters<typeof executeOnce>[0],
      { caller: flow.caller },
    );

    expect(flow.gens()).toBe(2);
    expect(flow.evals()).toBe(2);
    const msg = await prisma.message.findFirst({ where: { conversationId, clientMessageId: oneShotMessageKey(jobId) } });
    expect(msg?.content).toBe("FRAMED");
    // No Agent -> reflection metadata stays in-memory; no new rows are written.
    expect(await prisma.reflectionEvent.count({ where: { agent: { userId } } })).toBe(reflectionsBefore);
  });
});