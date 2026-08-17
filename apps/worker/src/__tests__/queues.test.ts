import { afterAll, describe, expect, test } from "bun:test";
import { Queue, Worker } from "bullmq";

// Config is validated at import time; set env before importing queues.js.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "queue-test-secret";

const { agentJobs, agentTriggerProcessor, agentTriggers, emailJobs, failedAgentJobs, onceJobs, scheduleMailPollSweep, startWorkers, webhookProcessing, wireDlq } = await import("../infra/queues.js");

const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
const workers = startWorkers();

async function poll<T>(fn: () => Promise<T>, ok: (t: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await Bun.sleep(50);
  }
}

afterAll(async () => {
  await Promise.all([
    ...workers.map((w) => w.close()),
    agentJobs.close(),
    onceJobs.close(),
    agentTriggers.close(),
    webhookProcessing.close(),
    failedAgentJobs.close(),
    emailJobs.close(),
  ]);
});

describe("queues function in isolation", () => {
  test("agent-jobs worker processes an enqueued job", async () => {
    const job = await agentJobs.add("execute", { agentId: "a-1", trigger: "user_message" });
    await poll(() => job.getState(), (s) => s === "completed");
    expect(await job.getState()).toBe("completed");
  });

  test("a job that exhausts retries lands in failed-agent-jobs (DLQ)", async () => {
    const name = `test-failing-${Date.now()}`;
    const q = new Queue(name, { connection });
    const w = new Worker<{ n: number }, void, string>(
      name,
      async () => {
        throw new Error("boom");
      },
      { connection, concurrency: 1 },
    );
    wireDlq(w);

    const job = await q.add("doomed", { n: 1 }, { attempts: 2, backoff: { type: "exponential", delay: 50 } });
    await poll(() => job.getState(), (s) => s === "failed");
    await poll(() => failedAgentJobs.getJobCounts("waiting"), (c) => (c.waiting ?? 0) >= 1);

    expect((await failedAgentJobs.getJobCounts("waiting")).waiting).toBeGreaterThanOrEqual(1);
    await w.close();
    await q.close();
  });
});

describe("mail-poll sweep (lazy)", () => {
  test("scheduleMailPollSweep registers the repeatable scheduler idempotently", async () => {
    await scheduleMailPollSweep();
    await scheduleMailPollSweep();
    const schedulers = await agentTriggers.getJobSchedulers();
    const pollScheduler = schedulers.find((s) => s.key === "mail-poll-sweep");
    expect(pollScheduler).toBeDefined();
    expect(pollScheduler?.pattern).toBe("*/5 * * * *");
  });

  test("agent-triggers worker dispatches a mail-poll-sweep job (runs pollImportantMail, completes)", async () => {
    // Use a throwaway queue + worker wired to the real processor: a live dev
    // worker owns the shared agent-triggers queue and would steal this job.
    const q = new Queue(`mail-poll-dispatch-${Date.now()}`, { connection });
    const w = new Worker(q.name, agentTriggerProcessor, { connection });
    const job = await q.add("mail-poll-sweep", { poll: true });
    // This processor runs a real pollImportantMail sweep (live Nango/Gmail
    // attempts over the shared test DB's connected rows), so it needs a longer
    // poll + test timeout than the 5s default — same as the other integration tests.
    await poll(() => job.getState(), (s) => s === "completed", 30_000);
    expect(await job.getState()).toBe("completed");
    await w.close();
    await q.close();
  }, 30_000);
});

describe("poller removal wiring", () => {
  test("queues module loads without throwing — no dangling poller exports remain", async () => {
    // The import above already proving the module evaluates is the load check;
    // this re-asserts the exported surface is exactly what remains. A dangling
    // import (catched only by runtime, not tsc) would have thrown at load time
    // and failed the whole file.
    const mod = (await import("../infra/queues.js")) as Record<string, unknown>;
    expect(mod.scheduleAdaptivePolling).toBeUndefined();
    expect(mod.scheduleReconciliation).toBeUndefined();
    expect(typeof mod.scheduleMailPollSweep).toBe("function");
    expect(typeof mod.scheduleTriggerTick).toBe("function");
    expect(typeof mod.scheduleWatchRenewal).toBe("function");
    expect(typeof mod.scheduleConnectionCanary).toBe("function");
    expect(typeof mod.agentTriggerProcessor).toBe("function");
  });

  test("agentTriggerProcessor has no adaptive-polling or reconciliation case (both hit the default noop)", async () => {
    // If someone re-added a case for either name, dispatching these job names
    // would run whatever was behind it (historically a roster fan-out) instead
    // of the default noop. Fails loudly: any execute job on the queue proves a
    // fan-out case exists again.
    const q = new Queue(`atp-poller-cases-${Date.now()}`, { connection });
    const w = new Worker(q.name, agentTriggerProcessor, { connection });
    const jobs = [
      await q.add("adaptive-polling", { poll: true }),
      await q.add("reconciliation", { reconcile: true }),
    ];
    await poll(
      () => Promise.all(jobs.map((j) => j.getState())),
      (states) => states.every((s) => s === "completed"),
      15_000,
    );
    const all = await q.getJobs(["completed", "failed", "waiting", "delayed", "active"]);
    expect(all.filter((j) => j.name === "execute")).toHaveLength(0);
    expect((await q.getJobCounts("failed")).failed ?? 0).toBe(0);
    await w.close();
    await q.close();
  }, 20_000);
});
