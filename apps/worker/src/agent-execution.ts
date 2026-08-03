import {
  AGENT_CONTEXT_MAX_EVENTS,
  AGENT_CONTEXT_MAX_TOKENS,
  callOpenRouter,
  getLogger,
  getPrismaClient,
  trackEvent,
  trackModelCall,
  rollDailyUsage,
} from "@mimir/backend-core";
import type { LlmMessage } from "@mimir/shared-types";
import type { Job } from "bullmq";
import { fetchEntityData } from "./mock-integration.js";
import { publishUserEvent } from "./redis.js";

const prisma = getPrismaClient();

// Plan 4.5.1: context = contextSummary (if set) + last N AgentEvents, capped at
// AGENT_CONTEXT_MAX_TOKENS. Rough token estimate (chars / 4) — good enough for a
// budget cap; exact tokenizer is unnecessary until the cap measurably bites.
async function loadContext(agentId: string): Promise<{ systemNote: string; history: LlmMessage[] }> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error(`agent ${agentId} not found`);

  const events = await prisma.agentEvent.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take: AGENT_CONTEXT_MAX_EVENTS,
  });
  events.reverse();

  const history: LlmMessage[] = [];
  let chars = 0;
  for (const ev of events) {
    const line = `[${ev.eventType}] ${JSON.stringify(ev.payload)}`;
    if (chars + line.length > AGENT_CONTEXT_MAX_TOKENS * 4) break;
    history.push({ role: "system", content: line });
    chars += line.length;
  }

  const systemNote = [
    `You are an execution agent. Task: ${agent.taskDescription}`,
    agent.contextSummary ? `Prior summary of this agent's activity:\n${agent.contextSummary}` : "",
    "You receive event history and current integration data. Produce a concise, useful result for the user.",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemNote, history };
}

// Plan 4.5.4: once event history exceeds the budget (count OR estimated token
// size — events embed full LLM output, so ~4 events can already fill the
// token cap and loadContext truncates), fold the events that no longer fit into
// Agent.contextSummary and delete them, so they aren't re-counted every run.
export async function foldOldEvents(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return;

  const keep = await prisma.agentEvent.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take: AGENT_CONTEXT_MAX_EVENTS,
  });
  // Same walk as loadContext: how many of the newest events fit the token
  // budget. If every event fits, there is nothing to fold.
  let chars = 0;
  let fit = 0;
  for (const ev of keep) {
    const line = `[${ev.eventType}] ${JSON.stringify(ev.payload)}`;
    if (chars + line.length > AGENT_CONTEXT_MAX_TOKENS * 4) break;
    chars += line.length;
    fit += 1;
  }
  if (fit === keep.length) return;

  const foldable = keep.slice(fit); // newest-first, beyond the fit window
  const foldableIds = foldable.map((e) => e.id);

  const text = foldable.map((e) => `[${e.eventType}] ${JSON.stringify(e.payload)}`).join("\n");
  const result = await callOpenRouter(
    [
      { role: "system", content: "Summarize these agent events into a compact prior-summary (a few sentences, keep key facts)." },
      { role: "user", content: text },
    ],
    { useCase: "agent_execution" },
  );
  await trackModelCall({ userId: agent.userId, useCase: "summarization", result });
  const merged = [agent.contextSummary, result.content].filter(Boolean).join("\n");
  await prisma.$transaction([
    prisma.agent.update({ where: { id: agentId }, data: { contextSummary: merged } }),
    prisma.agentEvent.deleteMany({ where: { id: { in: foldableIds } } }),
  ]);
  getLogger().info({ agentId, folded: foldable.length }, "older agent events folded into contextSummary");
}

// ponytail: folding is best-effort bookkeeping — a failure here must never flip
// an already-successful run to failed (the user-visible outcome is committed).
async function safeFold(agentId: string): Promise<void> {
  try {
    await foldOldEvents(agentId);
  } catch (e) {
    getLogger().error({ err: e, agentId }, "event fold failed (best-effort; run already succeeded)");
  }
}

// Plan 4.7.1: structured {surface, rationale, category}. Parse failure or low
// confidence -> don't surface (safe default: an unparseable filter shouldn't spam).
interface FilterVerdict {
  surface: boolean;
  rationale: string;
  category: "actionable" | "fyi" | "noise";
}

export async function filterVerdict(userId: string, content: string): Promise<FilterVerdict> {
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        'Decide if this agent result should be surfaced to the user. Respond STRICT JSON only: {"surface":true,"rationale":"<why>","category":"actionable"|"fyi"|"noise"}.',
    },
    { role: "user", content },
  ];
  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "agent_filter" });
  } catch (e) {
    getLogger().warn({ err: e }, "filter call failed; discarding result");
    await trackModelCall({ userId, useCase: "agent_filter", error: (e as Error)?.message ?? String(e) });
    return { surface: false, rationale: "filter unavailable", category: "noise" };
  }
  await trackModelCall({ userId, useCase: "agent_filter", result });
  try {
    const cleaned = result.content.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned) as { surface?: unknown; rationale?: unknown; category?: unknown };
    const surface = json.surface === true;
    const rationale = typeof json.rationale === "string" ? json.rationale : "";
    const category = json.category === "actionable" || json.category === "fyi" ? json.category : "noise";
    return { surface, rationale, category };
  } catch {
    getLogger().warn("filter output unparseable; discarding result");
    return { surface: false, rationale: "unparseable filter output", category: "noise" };
  }
}

// Plan 4.5.2-4.6: the real agent-jobs processor. Postgres writes (AgentEvent +
// Message) complete BEFORE any publish — no publish-before-write.
export async function executeAgent(job: Job): Promise<void> {
  const { agentId } = job.data as { agentId: string; trigger?: string };
  getLogger().info({ agentId, jobId: job.id }, "agent job started");

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    getLogger().warn({ agentId }, "agent job for missing agent; skipping");
    return;
  }

  const { systemNote, history } = await loadContext(agentId);
  const data = await fetchEntityData(agent.entity, agent.taskDescription);

  const llmMessages: LlmMessage[] = [
    { role: "system", content: systemNote },
    ...history,
    { role: "user", content: `Current integration data:\n${JSON.stringify(data, null, 2)}` },
  ];
  const result = await callOpenRouter(llmMessages, { useCase: "agent_execution" });
  await trackModelCall({ userId: agent.userId, useCase: "agent_execution", result });
  await rollDailyUsage(agent.userId, result.usage.totalTokens);

  await prisma.agent.update({ where: { id: agentId }, data: { lastActiveAt: new Date() } });

  // Plan 4.7.2: the discard path is never skipped — write surfaced OR discarded.
  const verdict = await filterVerdict(agent.userId, result.content);
  const eventType = verdict.surface ? "surfaced" : "discarded";
  await prisma.agentEvent.create({
    data: {
      agentId,
      eventType,
      payload: {
        content: result.content,
        rationale: verdict.rationale,
        category: verdict.category,
        model: result.actualModel ?? result.model,
        tokens: result.usage.totalTokens,
      },
    },
  });
  getLogger().info({ agentId, eventType, category: verdict.category }, "agent result filtered");

  // Plan 4.7.3: only surfaced events proceed to the write+publish path.
  if (!verdict.surface) {
    await trackEvent(agent.userId, "agent_event_discarded", { agentId, category: verdict.category });
    await safeFold(agentId);
    return;
  }

  // Plan 4.5.3: append to the owner conversation AFTER the AgentEvent write.
  const message = await prisma.message.create({
    data: {
      conversationId: agent.ownerConversationId,
      role: "assistant",
      content: result.content,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.latencyMs,
    },
  });
  await trackEvent(agent.userId, "agent_event_surfaced", { agentId, conversationId: agent.ownerConversationId });

  // Plan 4.6.1: publish only now, after the DB writes committed.
  try {
    await publishUserEvent(agent.userId, "new_message", { conversationId: agent.ownerConversationId, messageId: message.id });
    getLogger().info({ agentId, messageId: message.id }, "agent result published");
  } catch (e) {
    getLogger().error({ err: e, agentId }, "publish failed (message already written)");
  }

  await safeFold(agentId);
}
