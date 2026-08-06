import {
  AGENT_CONTEXT_MAX_EVENTS,
  AGENT_CONTEXT_MAX_TOKENS,
  callOpenRouter,
  executionSystemPrompt,
  frameResultForUser,
  getLogger,
  getPrismaClient,
  loadPrompt,
  trackEvent,
  trackModelCall,
  rollDailyUsage,
} from "@mimir/backend-core";
import type { LlmTool, ToolCall } from "@mimir/backend-core";
import type { LlmMessage } from "@mimir/shared-types";
import { toLlmTool } from "@mimir/tasks";
import { ConnectionError, GMAIL_INTEGRATION } from "@mimir/connection-provider";
import type { Job } from "bullmq";
import { fetchEntityData } from "../integrations/gmail/gmail.js";
import { publishUserEvent } from "../infra/redis.js";
import { validateTriggerFire } from "./trigger-eval.js";
import { agentTasksFor } from "./tasks-registry.js";
import { parseSurfaceVerdict } from "./triage.js";

const prisma = getPrismaClient();

// Context = contextSummary (if set) + last N AgentEvents, capped at
// AGENT_CONTEXT_MAX_TOKENS. Rough token estimate (chars / 4) — good enough for a
// budget cap; exact tokenizer is unnecessary until the cap measurably bites.
async function loadContext(agentId: string, context?: string): Promise<{ systemNote: string; history: LlmMessage[] }> {
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

  // Execution Agent system prompt: execution_engine.md persona + this run's
  // concrete task, user context, and folded prior-summary.
  const systemNote = executionSystemPrompt({
    task: agent.taskDescription,
    context,
    contextSummary: agent.contextSummary,
  });

  return { systemNote, history };
}

// Once event history exceeds the budget (count OR estimated token size — events
// embed full LLM output, so ~4 events can already fill the token cap and
// loadContext truncates), fold the events that no longer fit into
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
      { role: "system", content: loadPrompt("summarize_events.md") },
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

// Structured {surface, rationale, category}. Parse failure or low confidence ->
// don't surface (safe default: an unparseable filter shouldn't spam).
interface FilterVerdict {
  surface: boolean;
  rationale: string;
  category: "actionable" | "fyi" | "noise";
  // True only when the filter LLM itself failed (call error / unparseable
  // output), as opposed to a genuine "not important" verdict. Callers that
  // consume-and-claim (mail-poll) skip claiming on error so the item retries.
  error?: boolean;
}

// A direct user request is always surfaced — the user asked, so the answer is
// never spam. The noise filter only gates background/triggered runs (scheduled
// polls, webhooks), which can otherwise spam without a human in the loop. An
// explicitly-confirmed draft re-run (4.10) is also user-approval-driven, so its
// outcome surfaces rather than being silently filtered.
export function userTriggered(trigger: string | undefined): boolean {
  return trigger === "user_message" || trigger === "draft_confirmed";
}

// The execution agent's mid-completion tool roster (4.7.4 wait, 4.10 draft).
// Registered integration Tasks (4.9) get appended here later; the two system
// tools are terminal — calling one ends the turn.
export const agentSystemTools: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "wait",
      description:
        "Call this when this run's output is redundant or would be noise to the user — silently discard it. The run is logged as discarded but never surfaced.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "draft",
      description:
        "Insert verbatim content (e.g. an email draft) into the conversation EXACTLY as written — no persona rewrite. The user must confirm before you act on it; you will be re-run with the confirmed draft as context.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Full verbatim draft content to show the user." },
          actionLabel: { type: "string", description: "What will happen on confirm (e.g. 'send this email')." },
        },
        required: ["content", "actionLabel"],
        additionalProperties: false,
      },
    },
  },
];

export type AgentToolOutcome =
  | { outcome: "wait" }
  | { outcome: "draft"; messageId: string };

// Cross-path surface dedup: webhook and poll can both wake the same agent to
// re-fetch a mailbox that produced the same output. If the agent already
// surfaced this exact content, a repeat is not surfaced again.
export async function isDuplicateSurface(agentId: string, content: string): Promise<boolean> {
  const last = await prisma.agentEvent.findFirst({
    where: { agentId, eventType: "surfaced" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (!last) return false;
  const prev = (last.payload as { content?: unknown }).content;
  return typeof prev === "string" && prev === content;
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function?.arguments ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Executes one agent tool call, writing its DB records. `result` carries the
// LLM turn's usage/model for the AgentEvent payload. Returns the terminal
// outcome (wait/draft both end the turn); unknown tools throw so the run fails
// visibly rather than silently doing nothing.
export async function handleAgentTool(
  agentId: string,
  userId: string,
  ownerConversationId: string,
  toolCall: ToolCall,
  result: { model: string; actualModel?: string; usage: { totalTokens: number } },
): Promise<AgentToolOutcome> {
  const name = toolCall.function?.name ?? "";
  if (name === "wait") {
    // 4.7.4 — silent discard, logged as AgentEvent{discarded}. Deliberately
    // bypasses the async filter (4.7.1-3): the model already decided it's noise.
    await prisma.agentEvent.create({
      data: {
        agentId,
        eventType: "discarded",
        payload: {
          reason: "wait_tool",
          model: result.actualModel ?? result.model,
          tokens: result.usage.totalTokens,
        },
      },
    });
    getLogger().info({ agentId }, "agent output discarded via wait tool");
    return { outcome: "wait" };
  }
  if (name === "draft") {
    // 4.10 — verbatim content straight into the thread, no persona rewrite. The
    // pending toolCalls row doubles as the audit trail + confirmation hook (the
    // API's pending-draft resolver drives send/cancel on the user's next message).
    const args = parseToolArgs(toolCall);
    const content = typeof args.content === "string" ? args.content : "";
    const actionLabel = typeof args.actionLabel === "string" ? args.actionLabel : "";
    if (!content) throw new Error("draft tool called without content");
    const message = await prisma.message.create({
      data: {
        conversationId: ownerConversationId,
        role: "assistant",
        content,
        status: "complete",
        model: result.actualModel ?? result.model,
        tokenCount: result.usage.totalTokens,
        toolCalls: {
          type: "agent.draft",
          status: "pending",
          agentId,
          actionLabel,
          draft: { content },
        },
      },
    });
    await prisma.agentEvent.create({
      data: {
        agentId,
        eventType: "surfaced",
        payload: {
          content,
          category: "draft",
          rationale: "draft tool",
          model: result.actualModel ?? result.model,
          tokens: result.usage.totalTokens,
        },
      },
    });
    try {
      await publishUserEvent(userId, "new_message", { conversationId: ownerConversationId, messageId: message.id });
    } catch (e) {
      getLogger().error({ err: e, agentId }, "publish failed (draft already written)");
    }
    return { outcome: "draft", messageId: message.id };
  }
  throw new Error(`unknown agent tool: ${name}`);
}

export type FilterKind = "agent" | "email";

// Agent results and incoming mail need different importance rubrics. A generic
// "should this surface?" lets gpt-4o-mini treat a meeting invite with a
// one-line snippet as noise; the email rubric names the actionable signals
// (meetings, replies, deadlines) so those surface instead of being dropped.
export function filterSystemPrompt(kind: FilterKind): string {
  return kind === "email" ? loadPrompt("filter_email.md") : loadPrompt("filter_agent.md");
}

export async function filterVerdict(userId: string, content: string, kind: FilterKind = "agent"): Promise<FilterVerdict> {
  const messages: LlmMessage[] = [
    { role: "system", content: filterSystemPrompt(kind) },
    { role: "user", content },
  ];
  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "agent_filter" });
  } catch (e) {
    getLogger().warn({ err: e }, "filter call failed; discarding result");
    await trackModelCall({ userId, useCase: "agent_filter", error: (e as Error)?.message ?? String(e) });
    return { surface: false, rationale: "filter unavailable", category: "noise", error: true };
  }
  await trackModelCall({ userId, useCase: "agent_filter", result });
  const parsed = parseSurfaceVerdict(result.content);
  if (!parsed.ok) {
    getLogger().warn("filter output unparseable; discarding result");
    return { surface: false, rationale: "unparseable filter output", category: "noise", error: true };
  }
  return { surface: parsed.surface, rationale: parsed.rationale, category: parsed.category, error: false };
}

// The agent-jobs processor. Postgres writes (AgentEvent + Message) complete
// BEFORE any publish — no publish-before-write.
export async function executeAgent(job: Job): Promise<void> {
  const { agentId, trigger, triggerId, context } = job.data as {
    agentId: string;
    trigger?: string;
    triggerId?: string;
    context?: string;
  };
  getLogger().info({ agentId, jobId: job.id }, "agent job started");

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    getLogger().warn({ agentId }, "agent job for missing agent; skipping");
    return;
  }

  const { systemNote, history } = await loadContext(agentId, context);

  // Real integration fetch. ConnectionError fails fast to a surfaced reconnect
  // message (no silent retry loop); ProviderError and anything else rethrow into
  // BullMQ's attempts:5 exponential backoff.
  let data: unknown;
  try {
    data = await fetchEntityData(agent.userId, agent.entity, agent.taskDescription);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    getLogger().warn({ agentId, err: e }, "integration not usable; surfacing reconnect");
    // ponytail: per-kind retry counts ("retry 3x / retry once then surface")
    // aren't expressible in BullMQ's fixed per-job attempt count; the uniform 5x
    // policy plus this ConnectionError fail-fast covers it. Split into per-kind
    // policies only if a provider starts burning retries.
    await prisma.integrationConnection.updateMany({
      where: { userId: agent.userId, provider: GMAIL_INTEGRATION },
      data: { status: "expired" },
    });
    const content = "Connect Gmail to let me watch your email.";
    // Once we've nudged to connect, stop re-surfacing the same ask on every run
    // (the watch keeps firing while disconnected). Only re-nudge once the user
    // resolves it — otherwise the thread fills with duplicate Connect Gmail
    // messages for a single unavailable connection.
    const lastAssistant = await prisma.message.findFirst({
      where: { conversationId: agent.ownerConversationId, role: "assistant", status: "complete" },
      orderBy: { createdAt: "desc" },
    });
    const lastTool = lastAssistant?.toolCalls as { type?: string; status?: string } | null;
    if (lastTool?.type === "gmail.connect" && lastTool.status === "pending") {
      await safeFold(agentId);
      return;
    }
    await prisma.agentEvent.create({
      data: {
        agentId,
        eventType: "surfaced",
        payload: { content, rationale: "gmail connection unavailable", category: "actionable", reconnect: true },
      },
    });
    const message = await prisma.message.create({
      data: {
        conversationId: agent.ownerConversationId,
        role: "assistant",
        content,
        status: "complete",
        toolCalls: { type: "gmail.connect", status: "pending" },
      },
    });
    try {
      await publishUserEvent(agent.userId, "new_message", { conversationId: agent.ownerConversationId, messageId: message.id });
    } catch (publishErr) {
      getLogger().error({ err: publishErr, agentId }, "publish failed (reconnect message already written)");
    }
    await safeFold(agentId);
    return;
  }

  // Fire-time validation (4.11.6): the cheap model that classified the trigger
  // can misfire, so the owning agent re-checks the fired trigger's criteria
  // against the freshly-fetched data before acting. A mismatch is logged as
  // AgentEvent{trigger_skipped} and the run ends quietly — never surfaced.
  if (trigger === "trigger_fired" && triggerId) {
    const stillMatches = await validateTriggerFire(triggerId, data);
    if (!stillMatches) {
      await safeFold(agentId);
      return;
    }
  }

  const llmMessages: LlmMessage[] = [
    { role: "system", content: systemNote },
    ...history,
    { role: "user", content: `Current integration data:\n${JSON.stringify(data, null, 2)}` },
  ];

  // Build the agent's tool roster: system tools (wait/draft) + the user's
  // registered integration Tasks (browser always, notion when connected, MCP
  // servers' tools). The LLM sees them all as OpenAI function schemas.
  const availableTasks = await agentTasksFor(agent.userId);
  const tools = [
    ...agentSystemTools,
    ...availableTasks.map((t) => toLlmTool(t)),
  ];

  // Multi-turn tool loop (4.9): a terminal tool call (wait/draft) ends the run;
  // a registered Task result is appended as a tool message and the model is
  // re-called with the accumulated history. Capped so a misbehaving model can't
  // loop forever — a tool-call storm ends the run and falls through to filtering.
  const MAX_TOOL_DEPTH = 4;
  let result = await callOpenRouter(llmMessages, { useCase: "agent_execution", tools, toolChoice: "auto" });
  await trackModelCall({ userId: agent.userId, useCase: "agent_execution", result });

  for (let depth = 0; depth < MAX_TOOL_DEPTH && result.toolCalls?.length; depth++) {
    const toolResults: LlmMessage[] = [];
    for (const toolCall of result.toolCalls) {
      const name = toolCall.function?.name ?? "";
      if (name === "wait" || name === "draft") {
        const outcome = await handleAgentTool(agentId, agent.userId, agent.ownerConversationId, toolCall, result);
        if (outcome.outcome === "wait") {
          await trackEvent(agent.userId, "agent_event_discarded", { agentId, category: "wait_tool" });
          await safeFold(agentId);
          return;
        }
        if (outcome.outcome === "draft") {
          getLogger().info({ agentId, messageId: outcome.messageId }, "agent draft inserted (pending confirmation)");
          await safeFold(agentId);
          return;
        }
        continue;
      }
      const task = availableTasks.find((t) => t.name === name);
      if (!task) {
        toolResults.push({ role: "tool", toolCallId: toolCall.id, content: JSON.stringify({ error: `unknown tool: ${name}` }) });
        continue;
      }
      let output: unknown;
      try {
        const args = parseToolArgs(toolCall);
        output = await task.execute(args, { userId: agent.userId, agentId });
      } catch (e) {
        output = { error: (e as Error)?.message ?? String(e) };
      }
      toolResults.push({ role: "tool", toolCallId: toolCall.id, content: JSON.stringify(output) });
      getLogger().info({ agentId, tool: name }, "agent integration task executed");
    }

    llmMessages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    llmMessages.push(...toolResults);
    result = await callOpenRouter(llmMessages, { useCase: "agent_execution", tools, toolChoice: "auto" });
    await trackModelCall({ userId: agent.userId, useCase: "agent_execution", result });
  }
  await rollDailyUsage(agent.userId, result.usage.totalTokens);

  await prisma.agent.update({ where: { id: agentId }, data: { lastActiveAt: new Date() } });

  // The discard path is never skipped — write surfaced OR discarded.
  // Direct user requests always surface; background/triggered runs pass the
  // async filter (4.7).
  const verdict = userTriggered(trigger)
    ? { surface: true, rationale: "user-triggered", category: "actionable" as const }
    : await filterVerdict(agent.userId, result.content);
  // Cross-path dedup (6.x): webhook push AND adaptive poll can both wake the same
  // agent to re-fetch the same mailbox and both decide to surface the SAME
  // output. A duplicate is downgraded to `discarded` so the user isn't shown the
  // same message twice.
  const duplicate = verdict.surface && (await isDuplicateSurface(agentId, result.content));
  const verdict2 = duplicate
    ? { surface: false, rationale: "duplicate of an already-surfaced result", category: "noise" as const, error: false }
    : verdict;
  const eventType = verdict2.surface ? "surfaced" : "discarded";
  await prisma.agentEvent.create({
    data: {
      agentId,
      eventType,
      payload: {
        content: result.content,
        rationale: verdict2.rationale,
        category: verdict2.category,
        model: result.actualModel ?? result.model,
        tokens: result.usage.totalTokens,
      },
    },
  });
  getLogger().info({ agentId, eventType, category: verdict2.category }, "agent result filtered");

  // Only surfaced events proceed to the write+publish path.
  if (!verdict2.surface) {
    await trackEvent(agent.userId, "agent_event_discarded", { agentId, category: verdict2.category });
    await safeFold(agentId);
    return;
  }

  // Append to the owner conversation AFTER the AgentEvent write. The raw result
  // goes to the AgentEvent (audit trail); the user sees a framed version written
  // by the interaction-agent persona so internal agents/integrations/tools never
  // leak into chat (4.x execution -> Mimir -> user hop). Best-effort: if framing
  // fails, the raw result surfaces rather than dropping the message.
  const framed = await frameResultForUser({ result: result.content, userMessage: context ?? "" });
  const message = await prisma.message.create({
    data: {
      conversationId: agent.ownerConversationId,
      role: "assistant",
      content: framed,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.latencyMs,
    },
  });
  await trackEvent(agent.userId, "agent_event_surfaced", { agentId, conversationId: agent.ownerConversationId });

  // Publish only now, after the DB writes committed.
  try {
    await publishUserEvent(agent.userId, "new_message", { conversationId: agent.ownerConversationId, messageId: message.id });
    getLogger().info({ agentId, messageId: message.id }, "agent result published");
  } catch (e) {
    getLogger().error({ err: e, agentId }, "publish failed (message already written)");
  }

  await safeFold(agentId);
}
