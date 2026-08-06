import { getConfig, getLogger, MAIL_POLL_CRON, runWithContext } from "@mimir/backend-core";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { executeAgent } from "../agent/agent-execution.js";
import { runDormancySweep } from "../agent/dormancy.js";
import { sendEmailJob } from "../email/email-send-job.js";
import { pollImportantMail } from "./mail-poll.js";
import { runAdaptivePolling, ADAPTIVE_POLL_CRON, RECONCILE_CRON } from "./event-polling.js";
import { runTriggerSweep, TRIGGER_TICK_CRON } from "../agent/triggers.js";
import { runWatchRenewal } from "../integrations/gmail/watch-renewal.js";
import { runConnectionCanary } from "../integrations/connection-canary.js";

// ponytail: queue name constants live in worker until a producer needs them
// elsewhere; move to @mimir/backend-core then.
export const AGENT_JOBS = "agent-jobs";
export const AGENT_TRIGGERS = "agent-triggers";
export const WEBHOOK_PROCESSING = "webhook-processing";
export const FAILED_AGENT_JOBS = "failed-agent-jobs";
export const EMAIL_JOBS = "email-jobs";

const cfg = getConfig();
const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };

export const retryPolicy: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
};

export const agentJobs = new Queue(AGENT_JOBS, { connection });
export const agentTriggers = new Queue(AGENT_TRIGGERS, { connection });
export const webhookProcessing = new Queue(WEBHOOK_PROCESSING, { connection });
export const failedAgentJobs = new Queue(FAILED_AGENT_JOBS, { connection });
export const emailJobs = new Queue(EMAIL_JOBS, { connection });

// The explicit `${provider}:${externalId}` job ID is the webhook idempotency
// mechanism — never let BullMQ auto-generate an ID here.
export function addWebhookJob(provider: string, externalId: string, webhookEventId: string): Promise<Job> {
  return webhookProcessing.add("process", { webhookEventId }, { ...retryPolicy, jobId: `${provider}:${externalId}` });
}

async function noop(job: Job): Promise<void> {
  getLogger().info({ queue: job.queueName, id: job.id, data: job.data }, "job processed (no-op)");
}

// Daily repeatable job on agent-triggers; upsert is idempotent across restarts.
export async function scheduleDormancySweep(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "dormancy-sweep",
    { pattern: "0 3 * * *", immediately: false },
    { name: "dormancy-sweep", data: { sweep: true } },
  );
}

// Fixed-cadence inbox sweep; upserts alongside dormancy on the same scheduler.
export async function scheduleMailPollSweep(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "mail-poll-sweep",
    { pattern: MAIL_POLL_CRON, immediately: false },
    { name: "mail-poll-sweep", data: { poll: true } },
  );
}

// 1-min trigger tick (4.11): reuses the agent-triggers queue like the other
// cheap, low-frequency sweeps — no dedicated queue.
export async function scheduleTriggerTick(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "trigger-tick",
    { pattern: TRIGGER_TICK_CRON, immediately: false },
    { name: "trigger-tick", data: { triggers: true } },
  );
}

// 1-min adaptive per-connection polling tick (6.4.1).
export async function scheduleAdaptivePolling(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "adaptive-polling",
    { pattern: ADAPTIVE_POLL_CRON, immediately: false },
    { name: "adaptive-polling", data: { poll: true } },
  );
}

// 30-min reconciliation backstop (6.3): forces a poll of every connection even
// if its own interval isn't due (safety net for missed webhook deliveries).
export async function scheduleReconciliation(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "reconciliation",
    { pattern: RECONCILE_CRON, immediately: false },
    { name: "reconciliation", data: { reconcile: true } },
  );
}

// Daily gmail watch renewal sweep (6.2.2) — re-registers watches nearing expiry.
export async function scheduleWatchRenewal(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "watch-renewal",
    { pattern: "0 2 * * *", immediately: false },
    { name: "watch-renewal", data: { renew: true } },
  );
}

// Daily connection canary — exercises gmail getAccessToken so a silent break in
// the provider's token extraction is caught by a job, not a user.
export async function scheduleConnectionCanary(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "connection-canary",
    { pattern: "0 4 * * *", immediately: false },
    { name: "connection-canary", data: { canary: true } },
  );
}

// agent-triggers processor: dormancy + mail-poll sweeps are the only real jobs.
// Exported so tests can exercise it on a throwaway queue (the real
// agent-triggers queue may be consumed by a live dev worker during tests).
export async function agentTriggerProcessor(job: Job): Promise<void> {
  switch (job.name) {
    case "dormancy-sweep":
      await runDormancySweep();
      return;
    case "mail-poll-sweep":
      await pollImportantMail();
      return;
    case "trigger-tick":
      await runTriggerSweep();
      return;
    case "adaptive-polling":
      await runAdaptivePolling();
      return;
    case "reconciliation":
      await runAdaptivePolling({ force: true });
      return;
    case "watch-renewal":
      await runWatchRenewal();
      return;
    case "connection-canary":
      await runConnectionCanary();
      return;
    default:
      return noop(job);
  }
}

export function wireDlq<D, R, N extends string>(worker: Worker<D, R, N>): void {
  worker.on("failed", (job, err) => {
    // Guard against non-terminal 'failed' emissions (if any): only move a job
    // to the DLQ once its retries are actually exhausted.
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    failedAgentJobs.add("failed", {
      queue: worker.name,
      jobId: job.id,
      data: job.data,
      error: String(err),
      failedAt: new Date().toISOString(),
    }).catch((addErr) => getLogger().error({ queue: worker.name, id: job.id, addErr }, "failed to move job to DLQ"));
    getLogger().error({ queue: worker.name, id: job.id, err }, "job exhausted retries, moved to DLQ");
  });
}

export function startWorkers(): Worker[] {
  const registrations: Array<[Queue, (job: Job) => Promise<unknown>, { concurrency?: number }]> = [
    [agentJobs, executeAgent, { concurrency: 10 }],
    [agentTriggers, agentTriggerProcessor, { concurrency: 20 }],
    [webhookProcessing, noop, {}],
    [emailJobs, sendEmailJob, { concurrency: 5 }],
  ];

  const workers: Worker[] = [];
  for (const [queue, processor, workerOpts] of registrations) {
    // 1.2.1 — thread jobId through every log line in the job's lifecycle (the
    // api does the same for requestId). ALS carries it down the async chain.
    const withContext: (job: Job) => Promise<unknown> = (job) =>
      new Promise((resolve, reject) => {
        runWithContext({ jobId: String(job.id), queue: queue.name }, () => {
          processor(job).then(resolve, reject);
        });
      });
    const worker = new Worker(queue.name, withContext, { connection, ...workerOpts });
    wireDlq(worker);
    workers.push(worker);
  }
  return workers;
}
