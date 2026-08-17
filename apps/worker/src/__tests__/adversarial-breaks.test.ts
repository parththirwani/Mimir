import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { ToolCall } from "@mimir/backend-core";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "adversarial-breaks-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { isDuplicateSurface, executeAgent, executeOnce, agentMessageKey, oneShotMessageKey } = await import("../agent/agent-execution.js");
const { runTriggerSweep } = await import("../agent/triggers.js");
const { redis } = await import("../infra/redis.js");

const prisma = getPrismaClient();
const userId = `adv-${randomUUID()}`;
const convId = `adv-conv-${randomUUID()}`;
const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };

const baseUsage = { totalTokens: 5, promptTokens: 3, completionTokens: 2 };

// Injectable execution caller with a call counter and an optional crash point.
// Handles the "surface" framing use-case separately so the loop's raw content
// can differ from the framed message, mirroring the real flow.
function makeCaller(content: string, opts?: { crashOn?: number; toolCalls?: ToolCall[] }) {
  let calls = 0;
  const caller = async (_messages: unknown, options?: { useCase?: string }) => {
    calls += 1;
    if (opts?.crashOn && calls === opts.crashOn) throw new Error("simulated worker crash");
    if (options?.useCase === "surface") {
      return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
    }
    return { content, model: "m", latencyMs: 1, usage: baseUsage, ...(opts?.toolCalls ? { toolCalls: opts.toolCalls } : {}) };
  };
  return { caller, calls: () => calls };
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
});

afterAll(async () => {
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

async function newAgent(entity = "browser"): Promise<string> {
  const a = await prisma.agent.create({
    data: { userId, ownerConversationId: convId, taskDescription: "t", entity },
  });
  return a.id;
}

// Real content pairs from the Aug 17 incident. Each pair is the SAME answer
// produced by re-runs of the same agent; the overlaps measured 0.65-0.82.
const INCIDENT_PAIRS: Array<[string, string]> = [
  [
    "Looks like the answer is yes — Stripe has reportedly finalized a deal to acquire OpenRouter for a reported price of $500 million, according to Bloomberg. It looks like the deal has been signed and announced publicly, with the acquisition deal finalized as of late August 2026.",
    "Looks like OpenRouter is getting acquired by Stripe — Bloomberg reported on August 14, 2026 that the deal is finalized at around $500 million. So yes, it looks like it's happening.",
  ],
  [
    "Looks like it's happening: Stripe has reportedly finalized a deal to acquire OpenRouter. Bloomberg reported the acquisition at $500 million, finalized in late August 2026.",
    "Looks like OpenRouter is getting acquired by Stripe — Bloomberg reported on August 14, 2026 that the deal is finalized at around $500 million. So yes, it looks like it's happening.",
  ],
  [
    "Graphify is an open-source AI coding-assistant skill that turns any folder of files into a queryable, interactive knowledge graph. It uses local, deterministic tree-sitter AST parsing across 36 programming languages, with no vector store or embeddings needed.",
    "Here's the rundown on Graphify: **Graphify** is an open-source AI coding-assist skill that turns any folder into a queryable interactive knowledge graph, using deterministic tree-sitter parsing across 36 programming languages and no vector store or embeddings.",
  ],
];

describe("isDuplicateSurface — LLM judge catches real rewordings", () => {
  const agentId = `adv-dedup-${randomUUID()}`;
  const judge = async () => ({
    content: '{"duplicate": true}',
    model: "m",
    latencyMs: 1,
    usage: baseUsage,
  });
  beforeAll(async () => {
    await prisma.agent.create({ data: { id: agentId, userId, ownerConversationId: convId, taskDescription: "t" } });
  });
  for (const [i, [a, b]] of INCIDENT_PAIRS.entries()) {
    test(`real incident duplicate pair ${i} is caught (the answer the user never sees again)`, async () => {
      await prisma.agentEvent.create({ data: { agentId, eventType: "surfaced", payload: { content: a } } });
      expect(await isDuplicateSurface(agentId, b, { caller: judge })).toBe(true);
    });
  }
});

describe("trigger sweep — a matching trigger re-fires forever", () => {
  test("a matching trigger fires once per cooldown window, not every minute", async () => {
    const agentId = await newAgent();
    const trigger = await prisma.trigger.create({
      data: { agentId, name: "adv", criteria: "criteria that keeps holding" },
    });
    const queue = new Queue(`adv-trig-${Date.now()}`, { connection });
    const judge = async ({ agentId: a }: { agentId?: string }) => ({ matches: a === agentId, rationale: "still holds" });
    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      for (let tick = 0; tick < 3; tick++) {
        await runTriggerSweep({ evaluate: judge, queue });
        fakeNow += 60_001; // advance one minute + 1ms -> new jobId bucket
      }
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      const mine = jobs.filter((j) => (j.data as { agentId?: string }).agentId === agentId);
      // Tick 0 fires (cold lastFiredAt); ticks 1-2 land inside the 15-min
      // cooldown and are skipped BEFORE the judge runs.
      expect(mine.length).toBe(1);
    } finally {
      Date.now = realNow;
    }
    await queue.close();
    await prisma.trigger.deleteMany({ where: { id: trigger.id } });
  });
});

describe("executeAgent crash-after-write — no idempotency key (the documented gap)", () => {
  test("a BullMQ retry after the message write re-surfaces a second answer (only dedup guards it, and dedup is loose)", async () => {
    const agentId = await newAgent();
    const msgsBefore = await prisma.message.count({ where: { conversationId: convId } });

    // First run surfaces answer A (framed).
    const callerA = async (_messages: unknown, options?: { useCase?: string }) => {
      if (options?.useCase === "surface") {
        return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
      }
      return { content: "Stripe finalized a deal to acquire OpenRouter for $500M", model: "m", latencyMs: 1, usage: baseUsage };
    };
    await executeAgent({ id: "adv-exec", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: callerA,
    });
    expect(await prisma.message.count({ where: { conversationId: convId } }) - msgsBefore).toBe(1);

    // Retry (BullMQ re-runs the whole job after a crash between create+resolve).
    // The re-run produces the same answer in DIFFERENT wording — like a real LLM.
    const callerB = async (_messages: unknown, options?: { useCase?: string }) => {
      if (options?.useCase === "surface") {
        return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
      }
      return { content: "Bloomberg says Stripe is acquiring OpenRouter at $500M, deal finalized", model: "m", latencyMs: 1, usage: baseUsage };
    };
    await executeAgent({ id: "adv-exec", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: callerB,
    });

    // The user-visible contract: the answer was delivered once.
    expect(await prisma.message.count({ where: { conversationId: convId } }) - msgsBefore).toBe(1);
  });
});

describe("Fix 1 — crash idempotency, adversarial (Layer 2)", () => {
  test("concurrent retries with the same job id write exactly one message (unique-constraint backstop)", async () => {
    const agentId = await newAgent();
    const msgsBefore = await prisma.message.count({ where: { conversationId: convId } });
    const { caller } = makeCaller("the finding");
    const job = { id: "adv-race", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0];
    // Fire both without awaiting — simulate BullMQ dispatching a retry before the
    // first attempt's message write commits. Both pass the pre-check concurrently,
    // then race on the (conversationId, clientMessageId) unique constraint.
    const results = await Promise.allSettled([executeAgent(job, { caller }), executeAgent(job, { caller })]);
    expect(await prisma.message.count({ where: { conversationId: convId } }) - msgsBefore).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    // In a no-key test env the dedup judge fails open, so the loser reaches the
    // DB constraint — that backstop, not the pre-check, is what caps it at one.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0 && rejected[0]) {
      expect(String(rejected[0].reason)).toMatch(/Unique constraint|P2002|already exists/i);
    }
  });

  test("crash mid-tool-loop then retry with the same job id -> exactly one message (no partial + full)", async () => {
    const agentId = await newAgent();
    const msgsBefore = await prisma.message.count({ where: { conversationId: convId } });
    const ghostTool = { id: "t1", type: "function", function: { name: "ghost_task", arguments: "{}" } };
    const job = { id: "adv-midloop", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0];

    // Attempt 1: first LLM call returns a tool call (drives a second call), the
    // second call "crashes" — the process dies mid-loop, before any write.
    const crashing = makeCaller("interim", { crashOn: 2, toolCalls: [ghostTool] });
    await expect(executeAgent(job, { caller: crashing.caller })).rejects.toThrow("simulated worker crash");
    expect(await prisma.message.count({ where: { conversationId: convId } }) - msgsBefore).toBe(0);

    // Attempt 2 (BullMQ retry, same job id): completes the loop and surfaces once.
    const retry = makeCaller("final answer");
    await executeAgent(job, { caller: retry.caller });
    expect(await prisma.message.count({ where: { conversationId: convId } }) - msgsBefore).toBe(1);
  });

  test("a different job id is NOT suppressed by the idempotency key (job-keyed, not content-keyed)", async () => {
    const agentId = await newAgent();
    const first = makeCaller("same finding text");
    await executeAgent({ id: "adv-job-1", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: first.caller,
    });
    expect(first.calls()).toBeGreaterThan(0);

    // Second, INDEPENDENTLY-triggered run (different job id, same content). Fix 1
    // must not suppress it — that's Fix 3's (semantic dedup) job.
    const second = makeCaller("same finding text");
    await executeAgent({ id: "adv-job-2", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: second.caller,
    });
    expect(second.calls()).toBeGreaterThan(0);
  });

  test("draft messages carry no idempotency key (keyless by design)", async () => {
    const agentId = await newAgent();
    const draftCall = {
      id: "d1",
      type: "function",
      function: { name: "draft", arguments: JSON.stringify({ content: "Draft body", actionLabel: "send it" }) },
    };
    const { caller } = makeCaller("x", { toolCalls: [draftCall] });
    await executeAgent({ id: "adv-draft", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller,
    });
    const draft = await prisma.message.findFirst({ where: { conversationId: convId, content: "Draft body" } });
    expect(draft).not.toBeNull();
    expect(draft?.clientMessageId).toBeNull();
  });
});

describe("Fix 2 — trigger cooldown, adversarial (Layer 3)", () => {
  // Cooldown state lives entirely in the Trigger row (persisted), so every sweep
  // invocation is effectively a fresh process — these tests also cover restart
  // safety: set lastFiredAt in the DB and a NEW sweep run respects it.
  test("boundary timing: 14:59 after the last fire is skipped, 15:01 fires", async () => {
    const realNow = Date.now;
    const fakeNow = realNow();
    Date.now = () => fakeNow;
    const queue = new Queue(`adv-cd-bound-${randomUUID()}`, { connection });
    try {
      const agentId = await newAgent();
      const cooled = await prisma.trigger.create({
        data: { agentId, name: "cooled", criteria: "x", lastFiredAt: new Date(fakeNow - 14 * 60_000 - 59_000) },
      });
      const warm = await prisma.trigger.create({
        data: { agentId, name: "warm", criteria: "x", lastFiredAt: new Date(fakeNow - 15 * 60_000 - 1_000) },
      });
      const judge = async ({ agentId: a }: { agentId?: string }) => ({ matches: a === agentId, rationale: "holds" });
      await runTriggerSweep({ evaluate: judge, queue });
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      const ids = jobs.map((j) => j.id ?? "");
      expect(ids.some((id) => id.includes(warm.id))).toBe(true); // 15:01 -> fires
      expect(ids.some((id) => id.includes(cooled.id))).toBe(false); // 14:59 -> still cooled
    } finally {
      Date.now = realNow;
      await queue.close();
    }
  });

  test("a cooled trigger skips the judge entirely (zero model calls, not just zero jobs)", async () => {
    const realNow = Date.now;
    const base = realNow();
    const fakeNow = base;
    Date.now = () => fakeNow;
    const queue = new Queue(`adv-cd-spy-${randomUUID()}`, { connection });
    try {
      const agentId = await newAgent();
      await prisma.trigger.create({
        data: { agentId, name: "cooled", criteria: "x", lastFiredAt: new Date(base - 60_000) },
      });
      let judgeCalls = 0;
      const judge = async ({ agentId: a }: { agentId?: string }) => {
        if (a === agentId) judgeCalls += 1;
        return { matches: a === agentId, rationale: "holds" };
      };
      await runTriggerSweep({ evaluate: judge, queue });
      expect(judgeCalls).toBe(0);
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      expect(jobs.filter((j) => (j.data as { agentId?: string }).agentId === agentId)).toHaveLength(0);
    } finally {
      Date.now = realNow;
      await queue.close();
    }
  });

  test("cooldown is per-trigger, not a shared/global window", async () => {
    const realNow = Date.now;
    const base = realNow();
    const fakeNow = base;
    Date.now = () => fakeNow;
    const queue = new Queue(`adv-cd-per-${randomUUID()}`, { connection });
    try {
      const agentId = await newAgent();
      const cooled = await prisma.trigger.create({
        data: { agentId, name: "cooled", criteria: "x", lastFiredAt: new Date(base - 60_000) },
      });
      const fresh = await prisma.trigger.create({ data: { agentId, name: "fresh", criteria: "x" } });
      const judge = async ({ agentId: a }: { agentId?: string }) => ({ matches: a === agentId, rationale: "holds" });
      await runTriggerSweep({ evaluate: judge, queue });
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      const ids = jobs.map((j) => j.id ?? "");
      expect(ids.some((id) => id.includes(fresh.id))).toBe(true);
      expect(ids.some((id) => id.includes(cooled.id))).toBe(false);
    } finally {
      Date.now = realNow;
      await queue.close();
    }
  });

  test("lastFiredAt updates at fire time, not on a non-matching evaluation", async () => {
    const agentId = await newAgent();
    const trigger = await prisma.trigger.create({ data: { agentId, name: "t", criteria: "x" } });
    const queue = new Queue(`adv-cd-timing-${randomUUID()}`, { connection });
    const nomatch = async ({ agentId: a }: { agentId?: string }) => ({ matches: a !== agentId, rationale: "nope" });
    await runTriggerSweep({ evaluate: nomatch, queue });
    expect((await prisma.trigger.findUnique({ where: { id: trigger.id } }))?.lastFiredAt).toBeNull();
    const match = async ({ agentId: a }: { agentId?: string }) => ({ matches: a === agentId, rationale: "holds" });
    await runTriggerSweep({ evaluate: match, queue });
    expect((await prisma.trigger.findUnique({ where: { id: trigger.id } }))?.lastFiredAt).not.toBeNull();
    await queue.close();
  });
});

describe("cross-fix interaction — Aug 17 incident replay (Layer 5)", () => {
  // Mocking only Date.now leaves `new Date()` on the real clock, but the sweep
  // stamps lastFiredAt with `new Date()` while the cooldown reads `Date.now()`.
  // In production both are the same system clock; in a test they must be mocked
  // TOGETHER or the cooldown gap is computed against the wrong base. Replace the
  // whole Date constructor so no-arg construction also returns the fake clock.
  function mockFullClock(now: () => number): () => void {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args: unknown[]) {
        const init: [string | number] = args.length === 0 ? [now()] : (args as [string | number]);
        super(...init);
      }
      static now(): number {
        return now();
      }
    }
    (globalThis as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;
    return () => {
      (globalThis as { Date: typeof Date }).Date = RealDate;
    };
  }

  test("cooldown allows 16:18 and 16:46 fires, suppresses 16:49 and 16:52", async () => {
    const queue = new Queue(`adv-replay-${randomUUID()}`, { connection });
    const UTC = (h: number, m: number) => Date.UTC(2026, 7, 17, h, m, 0);
    const bucket = (h: number, m: number) => Math.floor(UTC(h, m) / 60_000);
    let fakeNow = UTC(16, 18);
    const restore = mockFullClock(() => fakeNow);
    try {
      const agentId = await newAgent();
      await prisma.trigger.create({ data: { agentId, name: "adv", criteria: "keeps holding" } });
      const judge = async ({ agentId: a }: { agentId?: string }) => ({ matches: a === agentId, rationale: "holds" });
      for (const [h, m] of [[16, 18], [16, 46], [16, 49], [16, 52]] as const) {
        fakeNow = UTC(h, m);
        await runTriggerSweep({ evaluate: judge, queue });
      }
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      const ids = jobs.filter((j) => (j.data as { agentId?: string }).agentId === agentId).map((j) => j.id ?? "");
      // Fired at 16:18 (cold) and 16:46 (+28 min > 15-min cooldown). 16:49 and
      // 16:52 land inside the window after 16:46 and are suppressed.
      expect(ids.length).toBe(2);
      expect(ids.some((id) => id.endsWith(`-${bucket(16, 18)}`))).toBe(true);
      expect(ids.some((id) => id.endsWith(`-${bucket(16, 46)}`))).toBe(true);
    } finally {
      restore();
      await queue.close();
    }
  });

  test("Fix 1 pre-check runs before any dedup: a retry never re-enters the tool loop (zero paid calls)", async () => {
    const agentId = await newAgent();
    const first = makeCaller("finding");
    await executeAgent({ id: "adv-order", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: first.caller,
    });
    expect(first.calls()).toBeGreaterThan(0);
    const retry = makeCaller("finding");
    await executeAgent({ id: "adv-order", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: retry.caller,
    });
    // Zero calls: the pre-check short-circuits before loadContext/the tool loop,
    // which is before the (paid) semantic-dedup judge would ever run.
    expect(retry.calls()).toBe(0);
  });
});

describe("post-review fixes (Layer 6)", () => {
  // A caller that reports a duplicate ONLY for the dedup use-case. Lets a
  // user-triggered run exercise the dedup gate without a real model: with the
  // old (ungated) code this would downgrade the result to discarded; the fixed
  // gate skips the judge for user-triggered runs so it surfaces regardless.
  function dedupCaller(content: string) {
    let calls = 0;
    let judged = 0;
    const caller = async (_messages: unknown, options?: { useCase?: string }) => {
      calls += 1;
      if (options?.useCase === "dedup_judgment") {
        judged += 1;
        return { content: '{"duplicate": true}', model: "m", latencyMs: 1, usage: baseUsage };
      }
      if (options?.useCase === "surface") return { content: "FRAMED", model: "m", latencyMs: 1, usage: baseUsage };
      return { content, model: "m", latencyMs: 1, usage: baseUsage };
    };
    return { caller, calls: () => calls, judged: () => judged };
  }

  async function priorSurfaced(agentId: string, content: string) {
    await prisma.agentEvent.create({
      data: { agentId, eventType: "surfaced", payload: { content, rationale: "prior", category: "actionable" } },
    });
  }

  test("Fix 1: a user-triggered run surfaces even though the dedup judge would say duplicate", async () => {
    const agentId = await newAgent();
    // Give the judge something to compare against. The injected caller answers
    // `duplicate: true`, so WITHOUT the user-triggered gate this run would be
    // downgraded to `discarded` and no message would be created. The gate must
    // skip the judge entirely for user_message.
    await priorSurfaced(agentId, "OpenRouter is being acquired by Stripe for $500M.");
    const dup = dedupCaller("OpenRouter is getting acquired by Stripe — $500M, per Bloomberg.");
    await executeAgent({ id: "adv-user-gate", data: { agentId, trigger: "user_message" } } as Parameters<typeof executeAgent>[0], {
      caller: dup.caller,
    });
    // The dedup judge must never have run for a user-triggered request.
    expect(dup.judged()).toBe(0);
    const msg = await prisma.message.findFirst({
      where: { conversationId: convId, content: "FRAMED" },
      orderBy: { createdAt: "desc" },
    });
    expect(msg).not.toBeNull();
    const agentEvent = await prisma.agentEvent.findFirst({
      where: { agentId, eventType: "surfaced" },
      orderBy: { createdAt: "desc" },
    });
    expect(agentEvent?.payload).not.toMatchObject({ rationale: "duplicate of an already-surfaced result" });
    expect(agentEvent?.payload).toMatchObject({ rationale: "user-triggered" });
  });

  test("Fix 2a: one-shot retry short-circuit re-publishes the already-written message (no duplication)", async () => {
    const oneShotConv = `adv-os-${randomUUID()}`;
    await prisma.conversation.create({ data: { id: oneShotConv, userId } });
    const message = await prisma.message.create({
      data: { conversationId: oneShotConv, role: "assistant", content: "prior", status: "complete", clientMessageId: oneShotMessageKey("adv-os-job") },
    });
    const publishSpy = spyOn(redis, "publish");
    try {
      const caller = dedupCaller("should not run");
      const job = { id: "adv-os-job", data: { userId, conversationId: oneShotConv, content: "x" } } as Parameters<typeof executeOnce>[0];
      await executeOnce(job, { caller: caller.caller });
      expect(caller.calls()).toBe(0); // tool loop skipped
      expect(publishSpy.mock.calls.length).toBe(1);
      const [channel, payload] = publishSpy.mock.calls[0] as [string, string];
      expect(channel).toBe(`user-events:${userId}`);
      expect(JSON.parse(payload).payload.messageId).toBe(message.id);
      const count = await prisma.message.count({ where: { clientMessageId: oneShotMessageKey("adv-os-job") } });
      expect(count).toBe(1);
    } finally {
      publishSpy.mockRestore();
      await prisma.message.deleteMany({ where: { conversationId: oneShotConv } });
      await prisma.conversation.deleteMany({ where: { id: oneShotConv } });
    }
  });

  test("Fix 2b: agent retry short-circuit re-publishes the already-written message (no duplication)", async () => {
    const agentId = await newAgent();
    const message = await prisma.message.create({
      data: { conversationId: convId, role: "assistant", content: "prior", status: "complete", clientMessageId: agentMessageKey("adv-agent-job") },
    });
    const publishSpy = spyOn(redis, "publish");
    try {
      const caller = dedupCaller("should not run");
      const job = { id: "adv-agent-job", data: { agentId, trigger: "trigger_fired", triggerId: "adv-trig", context: "c" } } as Parameters<typeof executeAgent>[0];
      await executeAgent(job, { caller: caller.caller });
      expect(caller.calls()).toBe(0); // tool loop skipped
      expect(publishSpy.mock.calls.length).toBe(1);
      const [channel, payload] = publishSpy.mock.calls[0] as [string, string];
      expect(channel).toBe(`user-events:${userId}`);
      expect(JSON.parse(payload).payload.messageId).toBe(message.id);
      const count = await prisma.message.count({ where: { clientMessageId: agentMessageKey("adv-agent-job") } });
      expect(count).toBe(1);
    } finally {
      publishSpy.mockRestore();
      await prisma.message.deleteMany({ where: { clientMessageId: agentMessageKey("adv-agent-job") } });
    }
  });
});