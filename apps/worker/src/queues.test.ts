import { afterAll, describe, expect, test } from "bun:test";
import { Queue, Worker } from "bullmq";

// Config is validated at import time; set env before importing queues.js.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "queue-test-secret";

const { agentJobs, agentTriggerProcessor, agentTriggers, failedAgentJobs, scheduleMailPollSweep, startWorkers, webhookProcessing, wireDlq } = await import("./queues.js");

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
    agentTriggers.close(),
    webhookProcessing.close(),
    failedAgentJobs.close(),
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
    await poll(() => job.getState(), (s) => s === "completed");
    expect(await job.getState()).toBe("completed");
    await w.close();
    await q.close();
  });
});
