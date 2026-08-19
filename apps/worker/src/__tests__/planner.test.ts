import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LlmMessage } from "@mimir/shared-types";
import type { LlmCaller } from "../agent/agent-execution.js";

// planner.ts / agent-execution.ts load prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "planner-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { parsePlan, planTask, executePlanSteps } = await import("../agent/planner.js");
const { executeAgent } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `planner-${randomUUID()}`;
const convId = `planner-conv-${randomUUID()}`;

const baseUsage = { totalTokens: 5, promptTokens: 3, completionTokens: 2 };
const chat = (c: string) => ({ content: c, model: "m", latencyMs: 1, usage: baseUsage });

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
});

afterAll(async () => {
  await prisma.plan.deleteMany({ where: { agent: { userId } } });
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
    data: { id: `planner-agent-${randomUUID()}`, userId, ownerConversationId: convId, taskDescription: task, entity: "browser", complexity },
  });
  return a.id;
}

function agentJob(agentId: string, id = `planner-job-${randomUUID()}`, trigger = "user_message") {
  return { id, data: { agentId, trigger } } as Parameters<typeof executeAgent>[0];
}

describe("parsePlan", () => {
  test("parses a valid ordered plan with tool hints", () => {
    const raw = JSON.stringify({
      steps: [
        { id: "s1", description: "find flights", dependsOn: [], toolHint: "browser" },
        { id: "s2", description: "book the cheapest", dependsOn: ["s1"] },
      ],
    });
    expect(parsePlan(raw)).toEqual([
      { id: "s1", description: "find flights", dependsOn: [], toolHint: "browser" },
      { id: "s2", description: "book the cheapest", dependsOn: ["s1"] },
    ]);
  });

  test("accepts markdown-fenced JSON, empty dependsOn, and a single step", () => {
    expect(parsePlan('```json\n{"steps":[{"id":"only","description":"one lookup","dependsOn":[]}]}\n```')).toEqual([
      { id: "only", description: "one lookup", dependsOn: [] },
    ]);
  });

  test("rejects a dependsOn entry referencing a missing id", () => {
    const raw = JSON.stringify({
      steps: [
        { id: "s1", description: "find", dependsOn: [] },
        { id: "s2", description: "book", dependsOn: ["s3"] },
      ],
    });
    expect(parsePlan(raw)).toBeNull();
  });

  test("rejects self/forward references, duplicate ids, and >5 steps", () => {
    expect(parsePlan(JSON.stringify({ steps: [{ id: "s1", description: "x", dependsOn: ["s1"] }] }))).toBeNull();
    expect(
      parsePlan(
        JSON.stringify({
          steps: [
            { id: "s1", description: "a", dependsOn: [] },
            { id: "s2", description: "b", dependsOn: ["s3"] },
            { id: "s3", description: "c", dependsOn: [] },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parsePlan(
        JSON.stringify({
          steps: [
            { id: "s1", description: "a", dependsOn: [] },
            { id: "s1", description: "b", dependsOn: [] },
          ],
        }),
      ),
    ).toBeNull();
    expect(parsePlan(JSON.stringify({ steps: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `s${i}`, description: `d${i}`, dependsOn: [] })) }))).toBeNull();
  });

  test("rejects empty, malformed, wrong-shaped, and top-level-array output", () => {
    expect(parsePlan("")).toBeNull();
    expect(parsePlan("  ")).toBeNull();
    expect(parsePlan("sure, here is a plan!")).toBeNull();
    expect(parsePlan('{"steps":"not-an-array"}')).toBeNull();
    expect(parsePlan('{"steps":[{"id":"s1","description":""}]}')).toBeNull();
    expect(parsePlan('{"steps":[{"description":"no id"}]}')).toBeNull();
    expect(parsePlan('{"steps":[{"id":"s1","dependsOn":"s2","description":"x"}]}')).toBeNull();
    expect(parsePlan('[{"id":"s1","description":"x"}]')).toBeNull();
  });
});

describe("planTask (fail-open)", () => {
  test("returns the parsed plan and tracks the call", async () => {
    const steps = await planTask(userId, "book a flight", undefined, async (messages) => {
      expect((messages.at(-1) as LlmMessage).content).toContain("<task>");
      return chat(JSON.stringify({ steps: [{ id: "s1", description: "find", dependsOn: [] }, { id: "s2", description: "book", dependsOn: ["s1"] }] }));
    });
    expect(steps).toEqual([
      { id: "s1", description: "find", dependsOn: [] },
      { id: "s2", description: "book", dependsOn: ["s1"] },
    ]);
    const row = await prisma.modelCallLog.findFirst({ where: { userId, useCase: "planning" }, orderBy: { createdAt: "desc" } });
    expect(row?.success).toBe(true);
  });

  test("carries the failure context into the replan call", async () => {
    await planTask(userId, "book a flight", 'Step "s2" failed with: tool provider 500', async (messages) => {
      const user = (messages.at(-1) as LlmMessage).content;
      expect(user).toContain("tool provider 500");
      expect(user).toContain("<failure_context>");
      return chat("{}");
    });
  });

  test("a thrown planner call is null (fail-open), tracked as an error", async () => {
    const steps = await planTask(userId, "book a flight", undefined, async () => {
      throw new Error("planner 502");
    });
    expect(steps).toBeNull();
    const row = await prisma.modelCallLog.findFirst({ where: { userId, useCase: "planning" }, orderBy: { createdAt: "desc" } });
    expect(row?.success).toBe(false);
  });

  test("unparseable planner output is null (fail-open)", async () => {
    const steps = await planTask(userId, "book a flight", undefined, async () => chat("here's my great plan"));
    expect(steps).toBeNull();
  });
});

describe("executePlanSteps (unit)", () => {
  test("executes steps in dependency order; later steps see prior results", async () => {
    const calls: string[] = [];
    const seen: Record<string, string[]> = {};
    const result = await executePlanSteps({
      steps: [
        { id: "find", description: "find flights", dependsOn: [] },
        { id: "book", description: "book it", dependsOn: ["find"] },
        { id: "confirm", description: "confirm booking", dependsOn: ["find", "book"] },
      ],
      userId,
      taskDescription: "t",
      generateStep: async (step, prior) => {
        calls.push(step.id);
        seen[step.id] = prior.map((p) => p.id);
        return { result: chat(`RESULT ${step.id}`) };
      },
      replan: async () => null,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["find", "book", "confirm"]);
    expect(seen["find"]).toEqual([]);
    expect(seen["book"]).toEqual(["find"]);
    expect(seen["confirm"]).toEqual(["find", "book"]);
    expect(result).toMatchObject({ outcome: "completed", result: { content: "RESULT confirm" } });
  });

  test("a mid-plan throw triggers a replan with failure context, then completes", async () => {
    const failureContexts: string[] = [];
    const result = await executePlanSteps({
      steps: [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
      userId,
      taskDescription: "book flight",
      generateStep: async (step) => {
        if (step.id === "s2") throw new Error("tool provider 500");
        return { result: chat(`RESULT ${step.id}`) };
      },
      replan: async (failureContext) => {
        failureContexts.push(failureContext);
        return [
          { id: "s1", description: "first", dependsOn: [] },
          { id: "s3", description: "retry differently", dependsOn: [] },
        ];
      },
    });
    expect(failureContexts).toHaveLength(1);
    expect(failureContexts[0]).toContain('"s2"');
    expect(failureContexts[0]).toContain("tool provider 500");
    expect(failureContexts[0]).toContain("s1: RESULT s1"); // completed-so-far context
    expect(result).toMatchObject({ outcome: "completed", result: { content: "RESULT s3" } });
  });

  test("replan cap exhaustion returns an explicit failure", async () => {
    let replans = 0;
    const result = await executePlanSteps({
      steps: [{ id: "s1", description: "first", dependsOn: [] }],
      userId,
      taskDescription: "t",
      generateStep: async (step) => {
        if (step.id === "s1") throw new Error("always fails");
        return { result: chat("ok") };
      },
      replan: async () => {
        replans += 1;
        return [{ id: "s1", description: "first", dependsOn: [] }];
      },
    });
    expect(replans).toBe(1); // PLAN_REPLAN_CAP = 2 total attempts (initial + 1 replan)
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected a failed result");
    expect(result.reason).toBe("Step s1 failed: always fails");
    expect(result.partialResult).toBeUndefined();
  });

  test("replan cap exhaustion keeps partial progress from completed steps", async () => {
    const result = await executePlanSteps({
      steps: [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
      userId,
      taskDescription: "t",
      generateStep: async (step) => {
        if (step.id === "s2") throw new Error("always fails");
        return { result: chat(`RESULT ${step.id}`) };
      },
      replan: async () => [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected a failed result");
    expect(result.partialResult).toMatchObject({ content: "RESULT s1" });
  });

  test("a replan that fails open (null / 1 step) fails explicitly", async () => {
    const result = await executePlanSteps({
      steps: [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
      userId,
      taskDescription: "t",
      generateStep: async (step) => {
        if (step.id === "s2") throw new Error("boom");
        return { result: chat("RESULT s1") };
      },
      replan: async () => null,
    });
    expect(result).toMatchObject({ outcome: "failed", reason: "Step s2 failed: boom", partialResult: { content: "RESULT s1" } });
  });

  test("a wait terminal outcome short-circuits the plan", async () => {
    const result = await executePlanSteps({
      steps: [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
      userId,
      taskDescription: "t",
      generateStep: async (step) => (step.id === "s1" ? { stopped: "wait" as const } : { result: chat("RESULT s2") }),
      replan: async () => null,
    });
    expect(result).toEqual({ outcome: "stopped", stopped: "wait" });
  });

  test("plan_step AgentEvents are written for 8.4.1 readback", async () => {
    const agentId = await newAgent("complex");
    await executePlanSteps({
      steps: [
        { id: "s1", description: "first", dependsOn: [] },
        { id: "s2", description: "second", dependsOn: [] },
      ],
      userId,
      taskDescription: "t",
      agentId,
      generateStep: async (step) => {
        if (step.id === "s2") throw new Error("boom");
        return { result: chat("RESULT s1") };
      },
      replan: async () => null,
    });
    const events = await prisma.agentEvent.findMany({ where: { agentId, eventType: "plan_step" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(["s1", "s2"]);
    expect((events[0]!.payload as { status: string }).status).toBe("completed");
    expect((events[1]!.payload as { status: string }).status).toBe("failed");
  });
});

// An injectable execution caller that sequences planner responses and per-gen
// outputs for the plan-first complex path. useCase routes: planning = the plan,
// agent_execution = step generations, surface = framing. `failGens` throws on
// those gen counts to simulate a step's tool loop failing (gen count is global
// across replans, so a repeated failing step needs its attempt-2 gen listed too).
function planFlowCaller(opts: {
  plans: Array<{ steps: Array<{ id: string; description: string; dependsOn: string[]; toolHint?: string }> }>;
  gens: string[];
  failGens?: number[];
}) {
  let planCount = 0;
  let genCount = 0;
  const planningMessages: string[] = [];
  const caller: LlmCaller = async (messages, options) => {
    if (options?.useCase === "planning") {
      const p = opts.plans[Math.min(planCount, opts.plans.length - 1)]!;
      planCount += 1;
      planningMessages.push((messages.at(-1) as LlmMessage | undefined)?.content ?? "");
      return chat(JSON.stringify(p));
    }
    if (options?.useCase === "surface") return chat("FRAMED");
    if (options?.useCase === "evaluation") return chat(JSON.stringify({ pass: true, score: 1, feedback: "ok" }));
    genCount += 1;
    if (opts.failGens?.includes(genCount)) throw new Error("tool provider 500");
    return chat(opts.gens[genCount - 1] ?? `GEN ${genCount}`);
  };
  return { caller, plans: () => planCount, gens: () => genCount, planningMessages: () => planningMessages };
}

describe("executeAgent — complex agent through plan-first execution", () => {
  test("complex agent plans, executes steps in dependency order, surfaces the last step's result", async () => {
    const agentId = await newAgent("complex");
    const flow = planFlowCaller({
      plans: [
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
      ],
      gens: ["FOUND FLIGHTS", "BOOKED FLIGHT"],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.plans()).toBe(1);
    expect(flow.gens()).toBe(2);

    const plan = await prisma.plan.findFirst({ where: { agentId }, orderBy: { createdAt: "desc" } });
    expect(plan?.status).toBe("completed");

    const stepEvents = await prisma.agentEvent.findMany({ where: { agentId, eventType: "plan_step" }, orderBy: { createdAt: "asc" } });
    expect(stepEvents.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(["find", "book"]);
    expect(stepEvents.every((e) => (e.payload as { status: string }).status === "completed")).toBe(true);

    // The last step's result surfaces through the existing surface path.
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect(surfaced?.payload).toMatchObject({ content: "BOOKED FLIGHT" });
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toBe("FRAMED");
  });

  // Phase 8 checkpoint: a 3-step DEPENDENT task (find -> book -> send) stores a
  // Plan, executes in dependency order (each later step sees earlier results),
  // and a mid-plan tool failure on "book" replans instead of dying silently.
  test("checkpoint: 3-step dependent task (find -> book -> send) executes in order; mid-plan failure replans", async () => {
    const agentId = await newAgent("complex");
    const flow = planFlowCaller({
      plans: [
        {
          steps: [
            { id: "find", description: "find the cheapest flight", dependsOn: [] },
            { id: "book", description: "book that flight", dependsOn: ["find"] },
            { id: "send", description: "send the booking confirmation to the user", dependsOn: ["find", "book"] },
          ],
        },
        {
          steps: [
            { id: "find", description: "find the cheapest flight", dependsOn: [] },
            { id: "book2", description: "book via a working provider", dependsOn: ["find"] },
            { id: "send", description: "send the booking confirmation to the user", dependsOn: ["find", "book2"] },
          ],
        },
      ],
      // Attempt 1: find(ok), book(FAIL), send(never runs). Attempt 2 (replanned):
      // find(ok), book2(ok), send(ok).
      gens: ["FOUND FLIGHT", "", "FOUND FLIGHT 2", "BOOKED FLIGHT 2", "SENT CONFIRMATION"],
      failGens: [2],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    // A Plan row was stored and finished completed.
    const plan = await prisma.plan.findFirst({ where: { agentId }, orderBy: { createdAt: "desc" } });
    expect(plan?.status).toBe("completed");

    // The replan was triggered by the failing "book" step carrying its context.
    expect(flow.plans()).toBe(2);
    const replanMsg = flow.planningMessages()[1];
    expect(replanMsg).toContain('"book"');
    expect(replanMsg).toContain("tool provider 500");
    expect(replanMsg).toContain("FOUND FLIGHT"); // completed-so-far context

    // Dependency order via plan_step readback. Attempt 1 ran find(ok) then
    // book(failed), which triggered the replan; attempt 2 ran find(ok) ->
    // book2(ok) -> send(ok). The failed step is audited, not suppressed.
    const stepEvents = await prisma.agentEvent.findMany({ where: { agentId, eventType: "plan_step" }, orderBy: { createdAt: "asc" } });
    expect(stepEvents.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(["find", "book", "find", "book2", "send"]);
    expect(stepEvents.filter((e) => (e.payload as { stepId: string }).stepId === "book").every((e) => (e.payload as { status: string }).status === "failed")).toBe(true);
    expect(stepEvents).toHaveLength(5);

    // The final "send" step's result surfaces (never died silently).
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect(surfaced?.payload).toMatchObject({ content: "SENT CONFIRMATION" });
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toBe("FRAMED");
  });

  test("a mid-plan tool failure triggers a replan with failure context; final result surfaces", async () => {
    const agentId = await newAgent("complex");
    const flow = planFlowCaller({
      plans: [
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "retry", description: "book via a different route", dependsOn: ["find"] },
          ],
        },
      ],
      gens: ["FOUND FLIGHTS", "", "FOUND FLIGHTS AGAIN", "BOOKED VIA RETRY"],
      failGens: [2],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.plans()).toBe(2);
    expect(flow.gens()).toBe(4);
    const replanMsg = flow.planningMessages()[1];
    expect(replanMsg).toContain("book");
    expect(replanMsg).toContain("tool provider 500");
    expect(replanMsg).toContain("FOUND FLIGHTS"); // completed-so-far context

    const plan = await prisma.plan.findFirst({ where: { agentId }, orderBy: { createdAt: "desc" } });
    expect(plan?.status).toBe("completed");
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect(surfaced?.payload).toMatchObject({ content: "BOOKED VIA RETRY" });
    // The Plan row stores the REPLANNED step set (accurate audit record), not
    // just the original plan.
    const storedSteps = plan?.steps as Array<{ id: string }>;
    expect(storedSteps.map((s) => s.id)).toEqual(["find", "retry"]);
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toBe("FRAMED");
  });

  test("replan cap exhaustion surfaces partial progress + an explicit failure (never silent)", async () => {
    const agentId = await newAgent("complex");
    const flow = planFlowCaller({
      plans: [
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
      ],
      gens: ["FOUND FLIGHTS", "", "FOUND FLIGHTS AGAIN", ""],
      failGens: [2, 4],
    });
    await executeAgent(agentJob(agentId), { caller: flow.caller });

    expect(flow.plans()).toBe(2);
    const plan = await prisma.plan.findFirst({ where: { agentId }, orderBy: { createdAt: "desc" } });
    expect(plan?.status).toBe("failed");
    const surfaced = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" } });
    expect((surfaced?.payload as { content: string }).content).toContain("FOUND FLIGHTS AGAIN");
    expect((surfaced?.payload as { content: string }).content).toContain("couldn't finish the rest");
    const msg = await prisma.message.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
    expect(msg?.content).toContain("FOUND FLIGHTS AGAIN");
    expect(msg?.content).toContain("couldn't finish the rest");
  });

  test("a BACKGROUND run's plan failure audits as discarded and never pushes raw output to the thread", async () => {
    const agentId = await newAgent("complex");
    const flow = planFlowCaller({
      plans: [
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
        {
          steps: [
            { id: "find", description: "find flights", dependsOn: [] },
            { id: "book", description: "book the cheapest", dependsOn: ["find"] },
          ],
        },
      ],
      gens: ["FOUND FLIGHTS", "", "FOUND FLIGHTS AGAIN", ""],
      failGens: [2, 4],
    });
    const messagesBefore = await prisma.message.count({ where: { conversationId: convId } });
    await executeAgent(agentJob(agentId, undefined, "poll"), { caller: flow.caller });

    expect(flow.plans()).toBe(2);
    // Audited as discarded — no chat message written for a background run.
    const discarded = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "discarded" } });
    expect((discarded?.payload as { rationale: string }).rationale).toBe("plan failure");
    expect((discarded?.payload as { error: string }).error).toContain("tool provider 500");
    expect(await prisma.message.count({ where: { conversationId: convId } })).toBe(messagesBefore);
  });
});