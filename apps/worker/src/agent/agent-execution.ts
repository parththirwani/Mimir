import {
  AGENT_CONTEXT_MAX_EVENTS,
  AGENT_CONTEXT_MAX_TOKENS,
  callOpenRouter,
  executionSystemPrompt,
  frameResultForUser,
  getLogger,
  getPrismaClient,
  loadPrompt,
  oneShotSystemPrompt,
  trackEvent,
  trackModelCall,
  rollDailyUsage,
} from "@mimir/backend-core";
import type { LlmCallOptions, LlmTool, ToolCall } from "@mimir/backend-core";
import type { ChatResult, LlmMessage } from "@mimir/shared-types";
import { toLlmTool, type Task } from "@mimir/tasks";
import { ConnectionError, GMAIL_INTEGRATION, ProviderError, ProviderErrorKind } from "@mimir/connection-provider";
import type { Job } from "bullmq";
import { fetchEntityData } from "../integrations/gmail/gmail.js";
import { publishUserEvent } from "../infra/redis.js";
import { evaluateTask, reflectionFeedbackMessage, reflectRun, type ReflectRunResult } from "./reflector.js";
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

// Provider failures that exhaust their retry cap (5.4.1) fold the agent quietly
// so background watches don't spam. But a run the USER is waiting on must not
// die in silence — surface the cause so they get an answer even when the answer
// is "this failed". Distinct from the ConnectionError reconnect nudge (no
// gmail.connect toolCall, no dedup — exhaustion happens once per job).
export function providerFailureContent(kind: ProviderErrorKind, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  switch (kind) {
    case "malformed_response":
      return `The Gmail connection is misconfigured — ${detail}`;
    case "rate_limited":
      return "Gmail is rate-limiting right now — I couldn't fetch your emails. Try again in a couple of minutes.";
    case "provider_down":
      return "Gmail is temporarily unavailable — I couldn't fetch your emails. Try again shortly.";
    default:
      return "I couldn't complete that — try again in a minute.";
  }
}

async function surfaceProviderFailure(
  agent: { id: string; userId: string; ownerConversationId: string },
  kind: ProviderErrorKind,
  err: unknown,
): Promise<void> {
  const content = providerFailureContent(kind, err);
  await prisma.agentEvent.create({
    data: {
      agentId: agent.id,
      eventType: "surfaced",
      payload: { content, rationale: "provider failure exhausted retries", category: "actionable" },
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: agent.ownerConversationId,
      role: "assistant",
      content,
      status: "complete",
    },
  });
  try {
    await publishUserEvent(agent.userId, "new_message", { conversationId: agent.ownerConversationId, messageId: message.id });
  } catch (publishErr) {
    getLogger().error({ err: publishErr, agentId: agent.id }, "publish failed (provider failure message already written)");
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
// tools are terminal — calling one ends the turn. wait is also offered to
// one-shot runs (executeOnce); draft is NOT — a draft's confirmation flow must
// resolve back to an Agent, and a one-shot run has no Agent.
export const waitSystemTool: LlmTool = {
  type: "function",
  function: {
    name: "wait",
    description:
      "Call this when this run's output is redundant or would be noise to the user — silently discard it. The run is logged as discarded but never surfaced.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const draftSystemTool: LlmTool = {
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
};

export const agentSystemTools: LlmTool[] = [waitSystemTool, draftSystemTool];

export type AgentToolOutcome =
  | { outcome: "wait" }
  | { outcome: "draft"; messageId: string };

// Cross-path surface dedup: webhook and poll can both wake the same agent to
// re-fetch a mailbox that produced the same output. If the agent already
// surfaced this content — EXACTLY or as a reworded near-duplicate (a re-run
// regenerates the same answer with different phrasing, which a string compare
// misses) — the repeat is not surfaced again. Compared against the last few
// surfaced events so a genuinely new finding isn't blocked by an older one.
//
// ponytail: the original 0.85 token-overlap heuristic missed real rewordings —
// the Aug 17 incident pairs measured 0.61-0.85 — so this delegates to a cheap
// judge model. Upgrade path: a fine-tuned classifier once dedup volume
// justifies the training effort.
export function parseDedupVerdict(raw: string): boolean {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { duplicate?: unknown };
    return json.duplicate === true;
  } catch {
    return false;
  }
}

export async function isDuplicateSurface(
  agentId: string,
  content: string,
  deps?: { caller?: LlmCaller },
): Promise<boolean> {
  const recent = await prisma.agentEvent.findMany({
    where: { agentId, eventType: "surfaced" },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { payload: true },
  });
  if (recent.length === 0) return false;

  const prior = recent
    .map((ev) => (ev.payload as { content?: unknown }).content)
    .filter((c): c is string => typeof c === "string");
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });

  const messages: LlmMessage[] = [
    { role: "system", content: loadPrompt("dedup_judgment.md") },
    { role: "user", content: `Already surfaced:\n${prior.map((p) => `- ${p}`).join("\n")}\n\nNew finding:\n${content}` },
  ];
  const caller = deps?.caller ?? callOpenRouter;
  let result;
  try {
    result = await caller(messages, { useCase: "dedup_judgment" });
  } catch (e) {
    getLogger().warn({ err: e, agentId }, "dedup judge call failed; surfacing (fail-open)");
    if (agent) {
      await trackModelCall({ userId: agent.userId, useCase: "dedup_judgment", error: (e as Error)?.message ?? String(e) });
    }
    return false;
  }
  if (agent) {
    await trackModelCall({ userId: agent.userId, useCase: "dedup_judgment", result });
  }
  return parseDedupVerdict(result.content);
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

// The capped multi-turn tool loop (4.9): call the model, execute the tool calls
// it makes (registered Tasks + system tools), and re-call with the accumulated
// history. Shared by executeAgent (persistent Agent runs) and executeOnce
// (one-shot runs with NO Agent row) so the loop is implemented once. Terminal
// system tools (wait/draft) are delegated to onTerminalTool: the agent path
// persists its AgentEvents/messages, the one-shot path discards silently.
export type LlmCaller = (messages: LlmMessage[], options?: LlmCallOptions) => Promise<ChatResult>;

export interface ToolLoopContext {
  messages: LlmMessage[];
  tools: LlmTool[];
  userId: string;
  availableTasks: Task[];
  /** Present for Agent runs (scopes agent-owned tools like trigger CRUD); absent for one-shot. */
  agentId?: string;
}

export type ToolLoopOutcome = { stopped: "wait" | "draft" } | { result: ChatResult };

type TerminalToolHandler = (
  name: string,
  toolCall: ToolCall,
  result: ChatResult,
) => Promise<{ handled: true; stopped: "wait" | "draft" } | { handled: false }>;

// Cap so a misbehaving model can't loop forever — a tool-call storm ends the run
// and falls through to surfacing whatever the last turn produced.
const MAX_TOOL_DEPTH = 4;

export async function runToolLoop(
  ctx: ToolLoopContext,
  onTerminalTool: TerminalToolHandler,
  caller: LlmCaller = callOpenRouter,
): Promise<ToolLoopOutcome> {
  const { messages, tools, userId, availableTasks, agentId } = ctx;
  let result = await caller(messages, { useCase: "agent_execution", tools, toolChoice: "auto" });
  await trackModelCall({ userId, useCase: "agent_execution", result });

  for (let depth = 0; depth < MAX_TOOL_DEPTH && result.toolCalls?.length; depth++) {
    const toolResults: LlmMessage[] = [];
    for (const toolCall of result.toolCalls) {
      const name = toolCall.function?.name ?? "";
      if (name === "wait" || name === "draft") {
        const terminal = await onTerminalTool(name, toolCall, result);
        if (terminal.handled) return { stopped: terminal.stopped };
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
        output = await task.execute(args, agentId ? { userId, agentId } : { userId });
      } catch (e) {
        output = { error: (e as Error)?.message ?? String(e) };
      }
      toolResults.push({ role: "tool", toolCallId: toolCall.id, content: JSON.stringify(output) });
      getLogger().info({ agentId, tool: name }, "integration task executed");
    }

    messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    messages.push(...toolResults);
    result = await caller(messages, { useCase: "agent_execution", tools, toolChoice: "auto" });
    await trackModelCall({ userId, useCase: "agent_execution", result });
  }
  await rollDailyUsage(userId, result.usage.totalTokens);
  return { result };
}

// Deterministic idempotency key for a one-shot surfaced message. Both the retry
// pre-check and the (conversationId, clientMessageId) unique constraint key on
// it. The "one-shot:" prefix can never collide with a client-generated UUID
// clientMessageId.
export function oneShotMessageKey(jobId: string): string {
  return `one-shot:${jobId}`;
}

// Deterministic idempotency key for an agent-run surfaced message (mirrors
// oneShotMessageKey). Same contract: the retry pre-check and the
// (conversationId, clientMessageId) unique constraint both key on it, and the
// "agent:" prefix can never collide with a client-generated UUID.
export function agentMessageKey(jobId: string): string {
  return `agent:${jobId}`;
}

// Retry-safety check (the same scrutiny the original investigation applied to
// executeAgent): a one-shot job runs under BullMQ's attempts:5 backoff, so a
// crash after prisma.message.create but before the job resolves would re-run the
// WHOLE tool loop and surface a SECOND answer. Short-circuit: if a prior attempt
// already wrote this job's surfaced message, a retry returns immediately instead
// of re-executing. Returns the message so the caller can re-publish a message
// whose crash came before the socket push.
export async function findOneShotSurfaced(conversationId: string, jobId: string): Promise<{ id: string } | null> {
  return prisma.message.findFirst({
    where: { conversationId, clientMessageId: oneShotMessageKey(jobId) },
    select: { id: true },
  });
}

// Retry-safety check for executeAgent (same scrutiny as findOneShotSurfaced): an
// agent job runs under BullMQ retries, so a crash after the surfaced message
// write but before the job resolves would re-run the whole tool loop and surface
// a SECOND answer. Short-circuit: if a prior attempt already wrote this job's
// surfaced message, the retry returns before re-executing.
export async function findAgentSurfaced(conversationId: string, jobId: string): Promise<{ id: string } | null> {
  return prisma.message.findFirst({
    where: { conversationId, clientMessageId: agentMessageKey(jobId) },
    select: { id: true },
  });
}

export interface OneShotJobData {
  userId: string;
  conversationId: string;
  content: string;
  // Phase 7 complexity gate: the classification call tags one_shot work simple|complex;
  // complex one-shot runs route through the reflector. Absent => simple.
  complexity?: "simple" | "complex";
}

// The one-shot processor: a single tool-backed answer with NO Agent row — the
// "one_shot" classification never spawns a persistent watch. Verification
// criterion: this handler never reads or writes prisma.agent.
export async function executeOnce(job: Job, opts?: { caller?: LlmCaller }): Promise<void> {
  const { userId, conversationId, content } = job.data as OneShotJobData;
  // BullMQ always assigns an id to a queued job; it types as optional.
  const jobId = job.id ?? "";
  const caller = opts?.caller ?? callOpenRouter;
  getLogger().info({ conversationId, jobId }, "one-shot job started");

  // Retry short-circuit: if a previous attempt already wrote the surfaced answer
  // for this job (then crashed before resolving), don't re-run the tool loop.
  const surfaced = await findOneShotSurfaced(conversationId, jobId);
  if (surfaced) {
    getLogger().info({ conversationId, jobId }, "one-shot already surfaced; skipping retry");
    // The prior attempt may have crashed after writing the message but before the
    // socket push — push again so the user actually sees it. The client replaces
    // its full message list on new_message, so a redundant push is harmless.
    try {
      await publishUserEvent(userId, "new_message", { conversationId, messageId: surfaced.id });
    } catch (e) {
      getLogger().error({ err: e, conversationId, messageId: surfaced.id }, "re-publish failed on one-shot retry short-circuit");
    }
    return;
  }

  const messages: LlmMessage[] = [
    { role: "system", content: oneShotSystemPrompt() },
    { role: "user", content },
  ];
  const availableTasks = await agentTasksFor(userId, { includeTriggerTools: false });
  const tools: LlmTool[] = [waitSystemTool, ...availableTasks.map((t) => toLlmTool(t))];

  // The wait escape hatch doubles as the one-shot terminal handler. Hoisted so
  // the reflector's retry rounds reuse it (runToolLoop mutates its messages
  // array, so each attempt must start from a fresh base).
  const onTerminalTool: TerminalToolHandler = async (name) => {
    if (name !== "wait") return { handled: false };
    getLogger().info({ conversationId, jobId }, "one-shot discarded via wait tool");
    return { handled: true, stopped: "wait" as const };
  };
  const generate: (feedback?: string) => Promise<ToolLoopOutcome> = async (feedback) => {
    // Fresh base per attempt: runToolLoop mutates the array it's given.
    const attemptMessages: LlmMessage[] = [...messages];
    if (feedback) attemptMessages.push({ role: "system", content: reflectionFeedbackMessage(feedback) });
    return runToolLoop({ messages: attemptMessages, tools, userId, availableTasks }, onTerminalTool, caller);
  };

  // Phase 7: a complex one-shot runs through the generator/evaluator loop. The
  // evaluator's task is the rewritten query (job.data.content). No agentId —
  // reflection metadata stays in-memory (no ReflectionEvent/AgentEvent rows).
  let finalOutcome: ToolLoopOutcome;
  let lowConfidence = false;
  if (job.data.complexity === "complex") {
    const reflected = await reflectRun({
      generate,
      evaluate: async (resultContent) => evaluateTask(userId, content, resultContent, caller),
      taskDescription: content,
      userId,
    });
    finalOutcome = reflected.outcome;
    lowConfidence = reflected.lowConfidence;
  } else {
    finalOutcome = await generate();
  }
  if ("stopped" in finalOutcome) return;
  const result = finalOutcome.result;

  // Direct user ask — never gated by the noise filter (mirrors userTriggered on
  // the agent path). The message write carries the job-scoped clientMessageId so
  // a post-write crash stays idempotent on retry.
  const framed = await frameResultForUser({ result: result.content, userMessage: content, userId, caller });
  const surfacedContent = lowConfidence
    ? `${framed}\n\n(Note: I couldn't fully verify this result — please double-check the details.)`
    : framed;
  const message = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: surfacedContent,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.latencyMs,
      clientMessageId: oneShotMessageKey(jobId),
    },
  });
  await trackEvent(userId, "one_shot_surfaced", { conversationId, messageId: message.id });

  // Publish only after the DB write committed; a publish failure must never flip
  // a successful run to failed (the message is already written).
  try {
    await publishUserEvent(userId, "new_message", { conversationId, messageId: message.id });
  } catch (e) {
    getLogger().error({ err: e, conversationId }, "publish failed (one-shot message already written)");
  }
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

// 5.4.1 per-kind retry policy. BullMQ has a single fixed attempt count per job,
// so express per-kind caps here instead. `null` = not a known provider error
// (LLM/unknown) → keep BullMQ's default retries. `0` = non-retryable, surface
// immediately with no retries.
//
// Cap convention: total runs (attemptsMade is 1 on the first run). A cap N means
// retries when attemptsMade < N, then surface at N → N-1 retries.
const RETRY_CAPS: Record<ProviderErrorKind, number> = {
  rate_limited: 4, // "retry up to 3x" → 3 retries (4 total runs)
  provider_down: 2, // "retry once then surface" → 1 retry
  malformed_response: 2, // → 1 retry then surface
  validation_failed: 0,
};

function classifyProviderError(e: unknown): ProviderErrorKind | null {
  return e instanceof ProviderError ? e.kind : null;
}

// The agent-jobs processor. Postgres writes (AgentEvent + Message) complete
// BEFORE any publish — no publish-before-write. `caller` is injectable for
// tests only (same pattern as executeOnce); production calls pass nothing.
export async function executeAgent(job: Job, opts: { caller?: LlmCaller } = {}): Promise<void> {
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

  // Retry short-circuit (the crash-after-write gap the one-shot path already
  // covers): a previous attempt that wrote this job's surfaced message then
  // crashed returns here instead of re-running the tool loop.
  const jobId = job.id ?? "";
  const surfaced = await findAgentSurfaced(agent.ownerConversationId, jobId);
  if (surfaced) {
    getLogger().info({ agentId, jobId }, "agent job already surfaced; skipping retry");
    // The prior attempt may have crashed after writing the message but before the
    // socket push — push again so the user actually sees it (the client replaces
    // its full message list on new_message, so a redundant push is harmless).
    try {
      await publishUserEvent(agent.userId, "new_message", { conversationId: agent.ownerConversationId, messageId: surfaced.id });
    } catch (e) {
      getLogger().error({ err: e, agentId, messageId: surfaced.id }, "re-publish failed on agent retry short-circuit");
    }
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
    if (e instanceof ConnectionError) {
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
  } else {
    // ProviderError (5.4.1): apply the per-kind retry cap instead of BullMQ's
    // uniform attempt count. Retryable kinds rethrow (BullMQ backoff) up to their
    // cap, then exhaust to a quiet audit trail — no DLQ churn for a provider
    // that keeps failing. Non-retryable (validation_failed) surfaces immediately.
    const kind = classifyProviderError(e);
    if (kind !== null) {
      const cap = RETRY_CAPS[kind];
      if (job.attemptsMade < cap) throw e;
      getLogger().warn({ agentId, err: e, kind, attempts: job.attemptsMade }, "provider error exhausted retries");
      if (userTriggered(trigger)) {
        await surfaceProviderFailure(agent, kind, e);
      }
      await safeFold(agentId);
      return;
    }
    // Unknown/LLM error: keep default retries.
    throw e;
  }
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

  const baseMessages: LlmMessage[] = [
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

  // Multi-turn tool loop (4.9) — shared with the one-shot path (executeOnce).
  // A terminal tool call (wait/draft) ends the run; a registered Task result is
  // appended as a tool message and the model is re-called with the accumulated
  // history, capped by MAX_TOOL_DEPTH inside runToolLoop. Hoisted so the
  // reflector's retry rounds reuse it (runToolLoop mutates its messages array,
  // so each attempt must start from a fresh base).
  const onTerminalTool: TerminalToolHandler = async (name, toolCall, result) => {
    if (name !== "wait" && name !== "draft") return { handled: false };
    const terminal = await handleAgentTool(agentId, agent.userId, agent.ownerConversationId, toolCall, result);
    if (terminal.outcome === "wait") return { handled: true, stopped: "wait" as const };
    if (terminal.outcome === "draft") {
      getLogger().info({ agentId, messageId: terminal.messageId }, "agent draft inserted (pending confirmation)");
      return { handled: true, stopped: "draft" as const };
    }
    return { handled: false };
  };
  const generate: (feedback?: string) => Promise<ToolLoopOutcome> = async (feedback) => {
    const attemptMessages = [...baseMessages];
    if (feedback) attemptMessages.push({ role: "system", content: reflectionFeedbackMessage(feedback) });
    return runToolLoop(
      { messages: attemptMessages, tools, userId: agent.userId, availableTasks, agentId },
      onTerminalTool,
      opts.caller,
    );
  };

  // Phase 7 (7.1): only `complex` agents route through the reflector. The first
  // generation IS the existing tool loop; a failed evaluation feeds feedback
  // back into a fresh retry. The first fetchEntityData result is reused — no
  // fresh fetch on retry. wait/draft short-circuit (never evaluated).
  let finalOutcome: ToolLoopOutcome;
  let lowConfidence = false;
  let retriedAttempts: ReflectRunResult["retriedAttempts"] = [];
  if (agent.complexity === "complex") {
    const reflected = await reflectRun({
      generate,
      evaluate: async (resultContent) => evaluateTask(agent.userId, agent.taskDescription, resultContent, opts.caller),
      taskDescription: agent.taskDescription,
      userId: agent.userId,
    });
    finalOutcome = reflected.outcome;
    lowConfidence = reflected.lowConfidence;
    retriedAttempts = reflected.retriedAttempts;
  } else {
    finalOutcome = await generate();
  }
  // 7.3.3 audit rows persisted AFTER the loop completes — and BEFORE the
  // terminal short-circuit, so a run that stopped (wait/draft) on a later
  // attempt still records its earlier failed attempts. A run that crashes
  // mid-loop persists nothing, so a BullMQ retry re-runs clean and can't
  // accumulate duplicate rows. No AgentEvent write — ReflectionEvent is the
  // audit trail; writing one would pollute loadContext's history with stale
  // per-attempt feedback. Best-effort: a failed write must never flip an
  // already-produced result.
  if (retriedAttempts.length > 0) {
    try {
      await prisma.reflectionEvent.createMany({
        data: retriedAttempts.map(({ attempt, verdict }) => ({
          agentId,
          attemptNumber: attempt,
          score: verdict.score,
          feedback: verdict.feedback,
        })),
      });
    } catch (e) {
      getLogger().error({ err: e, agentId, attempts: retriedAttempts.length }, "reflection event write failed (best-effort)");
    }
  }

  if ("stopped" in finalOutcome) {
    if (finalOutcome.stopped === "wait") {
      await trackEvent(agent.userId, "agent_event_discarded", { agentId, category: "wait_tool" });
    }
    await safeFold(agentId);
    return;
  }
  const result = finalOutcome.result;

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
  // same message twice. Only the background paths dedup: a direct user request
  // always surfaces, even if it rewords an earlier result — silently dropping an
  // explicit answer would be worse than a repeat.
  const duplicate =
    !userTriggered(trigger) &&
    verdict.surface &&
    (await isDuplicateSurface(agentId, result.content, opts.caller ? { caller: opts.caller } : undefined));
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
        // 7.3.2: exhausted reflector = best-scoring attempt, flagged, not blocked.
        ...(lowConfidence ? { lowConfidence: true } : {}),
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
  const framed = await frameResultForUser({
    result: result.content,
    userMessage: context ?? "",
    ...(opts.caller ? { caller: opts.caller } : {}),
  });
  // 7.3.2 low-confidence signal: a short appended note in the user-visible text
  // (no Message column — payload flag + text note; UI affordance deferred).
  const surfacedContent = lowConfidence
    ? `${framed}\n\n(Note: I couldn't fully verify this result — please double-check the details.)`
    : framed;
  const message = await prisma.message.create({
    data: {
      conversationId: agent.ownerConversationId,
      role: "assistant",
      content: surfacedContent,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.latencyMs,
      clientMessageId: agentMessageKey(jobId),
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
