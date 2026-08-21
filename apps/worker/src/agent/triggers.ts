import { getLogger, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError } from "@mimir/connection-provider";
import type { Queue } from "bullmq";
import { agentJobs, retryPolicy } from "../infra/queues.js";
import { evaluateTrigger } from "./trigger-eval.js";

const prisma = getPrismaClient();

// Trigger system: a 1-min scheduler tick evaluates every enabled trigger's
// natural-language criteria against the owning agent's current integration data
// with a cheap model. On a match the agent job is enqueued with
// trigger:"trigger_fired"; the owning agent then RE-CHECKS the criteria at fire
// time before acting. Mismatches there are logged but never surfaced.

export const TRIGGER_TICK_CRON = "* * * * *";

// Minimum gap between consecutive fires of the same trigger. Cooldown beats a
// "did we already surface this?" check on the agent side: it short-circuits
// BEFORE the judge runs, saving a model call per cooled trigger.
export const TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;

// `evaluate`/`queue` are injectable so tests can hand in a fake judge and a
// throwaway queue (the shared agent-jobs queue may be consumed by a live dev
// worker during tests).
export async function runTriggerSweep(deps: { evaluate?: typeof evaluateTrigger; queue?: Queue } = {}): Promise<number> {
  const judge = deps.evaluate ?? evaluateTrigger;
  const q = deps.queue ?? agentJobs;
  const triggers = await prisma.trigger.findMany({ where: { enabled: true }, include: { agent: true } });
  let fired = 0;
  for (const trigger of triggers) {
    try {
      if (trigger.lastFiredAt && Date.now() - trigger.lastFiredAt.getTime() < TRIGGER_COOLDOWN_MS) continue;
      const verdict = await judge({
        userId: trigger.agent.userId,
        agentId: trigger.agent.id,
        entity: trigger.agent.entity,
        taskDescription: trigger.agent.taskDescription,
        criteria: trigger.criteria,
      });
      if (!verdict.matches) continue;
      await q.add(
        "execute",
        { agentId: trigger.agent.id, trigger: "trigger_fired", triggerId: trigger.id },
        { ...retryPolicy, jobId: `trigger-${trigger.id}-${Math.floor(Date.now() / 60000)}` },
      );
      await prisma.trigger.update({ where: { id: trigger.id }, data: { lastFiredAt: new Date() } });
      fired += 1;
      getLogger().info({ triggerId: trigger.id, agentId: trigger.agent.id }, "trigger fired, agent job enqueued");
    } catch (e) {
      // A missing/expired integration isn't a transient failure — the trigger
      // simply can't be judged until the user reconnects. Log it once per tick
      // at info instead of erroring forever; when the connection comes back the
      // sweep evaluates it normally again.
      if (e instanceof ConnectionError) {
        getLogger().info({ err: e, triggerId: trigger.id }, "trigger skipped: integration not connected");
        continue;
      }
      getLogger().error({ err: e, triggerId: trigger.id }, "trigger sweep failed for trigger; continuing");
    }
  }
  return fired;
}
