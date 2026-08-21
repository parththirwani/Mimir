import { callOpenRouter, getLogger, getPrismaClient, loadPrompt, trackModelCall } from "@mimir/backend-core";
import type { LlmMessage } from "@mimir/shared-types";
import { fetchEntityData } from "../integrations/gmail/gmail.js";

// Shared trigger-criteria evaluation (4.11 + 4.11.6). Kept separate from
// triggers.ts so BOTH the scheduler sweep and the executing agent can call it
// without a circular import (triggers.ts -> queues.ts -> agent-execution.ts ->
// triggers.ts). No queue imports here.

const prisma = getPrismaClient();

export interface TriggerVerdict {
  matches: boolean;
  rationale: string;
}

const EVAL_SYSTEM = loadPrompt("trigger_eval.md");

export function parseTriggerVerdict(raw: string): TriggerVerdict {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { matches?: unknown; rationale?: unknown };
    return {
      matches: json.matches === true,
      rationale: typeof json.rationale === "string" ? json.rationale : "",
    };
  } catch {
    return { matches: false, rationale: "unparseable trigger verdict" };
  }
}

// Cheap-model evaluation of one trigger against data. Injectable via deps for
// tests (mirrors mail-poll's lazy-sweep pattern).
export async function evaluateTrigger(opts: {
  userId: string;
  agentId: string;
  entity: string | null;
  taskDescription: string;
  criteria: string;
  data?: unknown;
  deps?: { fetch?: typeof fetchEntityData };
}): Promise<TriggerVerdict> {
  const data = opts.data ?? (await (opts.deps?.fetch ?? fetchEntityData)(opts.userId, opts.entity, opts.taskDescription));
  const messages: LlmMessage[] = [
    { role: "system", content: EVAL_SYSTEM },
    { role: "user", content: `Trigger condition to check: ${opts.criteria}\n\nCurrent integration data:\n${JSON.stringify(data, null, 2)}` },
  ];
  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "classification" });
  } catch (e) {
    getLogger().warn({ err: e, triggerAgent: opts.agentId }, "trigger evaluation call failed; treating as no-match");
    await trackModelCall({ userId: opts.userId, useCase: "classification", error: (e as Error)?.message ?? String(e) });
    return { matches: false, rationale: "evaluation unavailable" };
  }
  await trackModelCall({ userId: opts.userId, useCase: "classification", result });
  return parseTriggerVerdict(result.content);
}

// Fire-time re-check: the cheap creation/trigger model is error-prone, so the
// owning agent re-validates the fired trigger's criteria against the SAME
// freshly-fetched data before acting. A mismatch is logged into the event stream
// but never surfaced to the user. `evaluate` injectable for tests.
// so the owning agent re-validates the fired trigger's criteria against the SAME
// freshly-fetched data before acting. A mismatch is logged into the event stream
// but never surfaced to the user. `evaluate` injectable for tests.
export async function validateTriggerFire(triggerId: string, data: unknown, deps: { evaluate?: typeof evaluateTrigger } = {}): Promise<boolean> {
  const judge = deps.evaluate ?? evaluateTrigger;
  const trigger = await prisma.trigger.findUnique({
    where: { id: triggerId },
    include: { agent: { select: { userId: true, entity: true, taskDescription: true } } },
  });
  if (!trigger) return false;
  const verdict = await judge({
    userId: trigger.agent.userId,
    agentId: trigger.agentId,
    entity: trigger.agent.entity,
    taskDescription: trigger.agent.taskDescription,
    criteria: trigger.criteria,
    data,
  });
  if (verdict.matches) return true;
  await prisma.agentEvent.create({
    data: {
      agentId: trigger.agentId,
      eventType: "trigger_skipped",
      payload: { triggerId, criteria: trigger.criteria, rationale: verdict.rationale },
    },
  });
  getLogger().info({ triggerId, agentId: trigger.agentId, rationale: verdict.rationale }, "fired trigger re-check failed; logged, not surfaced");
  return false;
}