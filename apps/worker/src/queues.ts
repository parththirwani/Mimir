import { getConfig, getLogger } from "@mimir/backend-core";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { executeAgent } from "./agent-execution.js";
import { runDormancySweep } from "./dormancy.js";

// ponytail: queue name constants live in worker until a producer needs them
// elsewhere (api's Phase 6 webhook route); move to @mimir/backend-core then.
export const AGENT_JOBS = "agent-jobs";
export const AGENT_TRIGGERS = "agent-triggers";
export const WEBHOOK_PROCESSING = "webhook-processing";
export const FAILED_AGENT_JOBS = "failed-agent-jobs";

const cfg = getConfig();
const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };

// Plan 3.1.1/3.1.3 retry policy — per-job defaults; values are final per the plan.
export const retryPolicy: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
};

export const agentJobs = new Queue(AGENT_JOBS, { connection });
export const agentTriggers = new Queue(AGENT_TRIGGERS, { connection });
export const webhookProcessing = new Queue(WEBHOOK_PROCESSING, { connection });
export const failedAgentJobs = new Queue(FAILED_AGENT_JOBS, { connection });

// Plan 3.1.3: the explicit `${provider}:${externalId}` job ID is the webhook
// idempotency mechanism — never let BullMQ auto-generate an ID here.
export function addWebhookJob(provider: string, externalId: string, webhookEventId: string): Promise<Job> {
  return webhookProcessing.add("process", { webhookEventId }, { ...retryPolicy, jobId: `${provider}:${externalId}` });
}

// Plan 3.1: no-op processors prove the queues function in isolation. Phase 4/6
// replace them with the real handlers.
async function noop(job: Job): Promise<void> {
  getLogger().info({ queue: job.queueName, id: job.id, data: job.data }, "job processed (no-op)");
}

// Plan 4.8.1: the dormancy sweep is a daily repeatable job on agent-triggers.
// BullMQ 6 API: a job scheduler (upsert is idempotent across worker restarts).
export async function scheduleDormancySweep(): Promise<void> {
  await agentTriggers.upsertJobScheduler(
    "dormancy-sweep",
    { pattern: "0 3 * * *", immediately: false },
    { name: "dormancy-sweep", data: { sweep: true } },
  );
}

// agent-triggers processor: dormancy sweep is the only real job for now; anything
// else is Phase 6's per-connection polling, still a no-op.
async function agentTriggerProcessor(job: Job): Promise<void> {
  if (job.name === "dormancy-sweep") {
    await runDormancySweep();
    return;
  }
  return noop(job);
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
  ];

  const workers: Worker[] = [];
  for (const [queue, processor, workerOpts] of registrations) {
    const worker = new Worker(queue.name, processor, { connection, ...workerOpts });
    wireDlq(worker);
    workers.push(worker);
  }
  return workers;
}
