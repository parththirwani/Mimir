import { describe, expect, test } from "bun:test";
import type { ChatResult } from "@mimir/shared-types";
import type { PlanStep } from "../agent/planner.js";

// planner.ts (and its reflectr/type imports) pull backend-core at import time,
// which needs these env vars even though these tests never touch the DB.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "orchestrator-test-secret";

// Phase 9 orchestrator tests. executePlanSteps with no agentId/planId writes no
// DB rows (updatePlanStatus/recordStepOutcome early-return), so these are pure.
const { computeParallelGroups, executePlanSteps } = await import("../agent/planner.js");

const baseUsage = { totalTokens: 1, promptTokens: 1, completionTokens: 0 };
const chat = (c: string): ChatResult => ({ content: c, model: "m", latencyMs: 1, usage: baseUsage });
const step = (id: string, dependsOn: string[] = []): PlanStep => ({ id, description: id, dependsOn });
const done = (id: string) => ({ result: chat(`R ${id}`) });

describe("computeParallelGroups (9.1.1 — parallelism from the deps DAG)", () => {
  test("a dependency chain stays fully sequential", () => {
    const g = computeParallelGroups([step("a"), step("b", ["a"]), step("c", ["b"])]);
    expect(g.map((gr) => gr.map((s) => s.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  test("independent steps land in the same parallel group", () => {
    const g = computeParallelGroups([step("a"), step("b"), step("c")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("dependency depth splits into ordered parallel groups (no cross sib dep)", () => {
    // s2 depends on s1; s3 depends on s1 too -> s2/s3 are depth-2 siblings, parallel.
    const g = computeParallelGroups([
      step("s1"),
      step("s2", ["s1"]),
      step("s3", ["s1"]),
      step("s4", ["s2", "s3"]),
    ]);
    expect(g.map((gr) => gr.map((s) => s.id))).toEqual([["s1"], ["s2", "s3"], ["s4"]]);
  });
});

describe("executePlanSteps — Phase 9 parallel orchestration", () => {
  test("independent steps in a group run concurrently (parallel fan-out)", async () => {
    let active = 0;
    let maxActive = 0;
    await executePlanSteps({
      steps: [step("a"), step("b"), step("c")],
      userId: "u",
      taskDescription: "t",
      generateStep: async (s) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return done(s.id);
      },
      replan: async () => null,
    });
    expect(maxActive).toBeGreaterThan(1);
  });

  test("allSettled unwrap surfaces a rejected worker as missing, others proceed (partial failure)", async () => {
    const captured: Array<{ outs: Array<{ stepId: string; content: string }>; missing: string[] }> = [];
    const result = await executePlanSteps({
      steps: [step("a"), step("b"), step("c")],
      userId: "u",
      taskDescription: "check prices on 3 sites",
      generateStep: async (s) => {
        if (s.id === "b") throw new Error("bad URL");
        return done(s.id);
      },
      aggregate: async (_u, _t, outs, missing) => {
        captured.push({ outs, missing });
        return chat("AGGREGATED");
      },
      replan: async () => null,
    });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.result.content).toBe("AGGREGATED");
    expect(captured[0]!.outs.map((o) => o.stepId).sort()).toEqual(["a", "c"]);
    expect(captured[0]!.missing).toEqual(["b"]); // the bad-URL worker was recorded, not swallowed
  });

  test("no aggregation call when a terminal parallel batch fully succeeds with multiple outputs -> still aggregates", async () => {
    const called: Array<{ outs: Array<{ stepId: string; content: string }>; missing: string[] }> = [];
    const result = await executePlanSteps({
      steps: [step("a"), step("b")],
      userId: "u",
      taskDescription: "compare two sites",
      generateStep: async (s) => done(s.id),
      aggregate: async (_u, _t, outs, missing) => {
        called.push({ outs, missing });
        return chat("AGGREGATED");
      },
      replan: async () => null,
    });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.result.content).toBe("AGGREGATED");
    expect(called).toHaveLength(1);
    expect(called[0]!.outs.map((o) => o.stepId).sort()).toEqual(["a", "b"]);
    expect(called[0]!.missing).toEqual([]);
  });

  test("whole-group failure (all members reject) triggers replan, not partial-proceed", async () => {
    const replanContexts: string[] = [];
    const result = await executePlanSteps({
      steps: [step("a"), step("b")],
      userId: "u",
      taskDescription: "t",
      generateStep: async () => {
        throw new Error("both down");
      },
      aggregate: async () => chat("SHOULD NOT RUN"),
      replan: async (ctx) => {
        replanContexts.push(ctx);
        return [step("a"), step("b")];
      },
    });
    expect(replanContexts).toHaveLength(1);
    expect(replanContexts[0]).toContain("both down");
    expect(result.outcome).toBe("failed");
  });

  test("slices past MAX_PARALLEL_WORKERS still all run when an early slice rejects", async () => {
    const started: string[] = [];
    const result = await executePlanSteps({
      // 6 independent steps => 2 slices (5 + 1) under MAX_PARALLEL_WORKERS=5.
      steps: [step("s1"), step("s2"), step("s3"), step("s4"), step("s5"), step("s6")],
      userId: "u",
      taskDescription: "t",
      generateStep: async (s) => {
        started.push(s.id);
        if (s.id === "s1") throw new Error("boom"); // slice 1 rejection
        return done(s.id);
      },
      replan: async () => null,
    });
    // Every step was started (slices 2+ ran even after slice 1's rejection).
    expect(started.sort()).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(result.outcome).toBe("completed");
  });
});
