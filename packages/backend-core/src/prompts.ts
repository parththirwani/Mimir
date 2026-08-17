import { readFileSync } from "node:fs";
import { callOpenRouter } from "./openrouter.js";
import { getLogger } from "./logger.js";
import { trackModelCall } from "./usage.js";
import type { LlmMessage } from "@mimir/shared-types";

// Prompt files are read from disk at runtime (same pattern as model-config.json)
// so they can be edited without a rebuild. They live in
// packages/backend-core/src/prompts so BOTH the api (Interaction Agent persona)
// and the worker (execution engine) can read them, and `turbo prune` keeps them
// in each app's Docker image.

const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

const fileCache = new Map<string, string>();

export function loadPrompt(name: string): string {
  let text = fileCache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(name, PROMPTS_DIR), "utf8");
    fileCache.set(name, text);
  }
  return text;
}

// Interaction Agent (chat) system prompt: persona + rules + integrations +
// email formatting + memory guidance, composed once and cached.
let chatPromptCache: string | null = null;

export function chatSystemPrompt(): string {
  if (!chatPromptCache) {
    chatPromptCache = [
      loadPrompt("system.md"),
      loadPrompt("rules.md"),
      loadPrompt("integrations.md"),
      loadPrompt("email.md"),
      loadPrompt("meomery.md"),
      // ponytail: the persona files were written for an interaction agent that
      // HAS real agent/tool-calling. This deployment does not expose those tools
      // in the chat turn, so without this guard the model improvises fake tool
      // calls (e.g. `<send_message_to_agent name="search_agent">`) as visible
      // text, leaking the internal design to the user. Keep this authoritative
      // no-tools declaration LAST so it isn't overridden. Revisit when real tools
      // are actually wired into chat_response.
      loadPrompt("chat_no_tools.md"),
    ].join("\n\n---\n\n");
  }
  return chatPromptCache;
}

// Execution Agent (worker) system prompt: the execution-engine persona plus the
// concrete task, user context, and folded prior-summary for this run. The
// factual-only guard is kept from the original inline prompt — fabrication in an
// execution run is a correctness bug, not a style choice.
export function executionSystemPrompt(opts: {
  task: string;
  context?: string | null;
  contextSummary?: string | null;
}): string {
  return [
    loadPrompt("execution_engine.md"),
    `You are an execution agent working for Mimir. Task: ${opts.task}`,
    opts.context ? `The user's latest message to address: ${opts.context}` : "",
    opts.contextSummary ? `Prior summary of this agent's activity:\n${opts.contextSummary}` : "",
    "You receive event history and current integration data. Produce a concise, useful result for Mimir.",
    loadPrompt("execution_facts.md"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// One-shot execution (worker): a single tool-backed answer with NO persistent
// Agent. Same factual-only guard as the agent path; the persona + no-persistence
// contract come from one_shot.md. UseCase for the LLM call stays
// "agent_execution" so deployments don't need a new model-config entry.
export function oneShotSystemPrompt(): string {
  return [
    loadPrompt("execution_engine.md"),
    loadPrompt("one_shot.md"),
    "You receive the user's query. Produce a concise, useful answer for Mimir.",
    loadPrompt("execution_facts.md"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Format the raw execution result into a user-facing message (the missing
// "execution -> Mimir -> user" hop). The raw result is never shown verbatim; the
// interaction-agent persona composes the reply so internal agents/integrations/
// tools stay hidden. Best-effort: a failure returns the original result so a
// useful surfaced message is never dropped, but it IS logged.
export interface FrameResultOptions {
  result: string;
  userMessage: string;
  history?: LlmMessage[];
  /** Injectable LLM caller for tests. */
  caller?: (messages: LlmMessage[], options?: { useCase: string }) => Promise<{ content: string }>;
  userId?: string;
}

export async function frameResultForUser(opts: FrameResultOptions): Promise<string> {
  const template = loadPrompt("surface.md")
    .replace("{result}", opts.result)
    .replace("{userMessage}", opts.userMessage);
  const messages: LlmMessage[] = [{ role: "system", content: chatSystemPrompt() }, ...(opts.history ?? []), { role: "user", content: template }];
  const caller = opts.caller ?? (async (msgs, options) => callOpenRouter(msgs, options));
  try {
    const res = await caller(messages, { useCase: "surface" });
    // Only attribute telemetry when there's a real user; an empty/anonymous
    // framing (e.g. tests, no userId) must not write a row that violates the FK.
    if (opts.userId) {
      await trackModelCall({ userId: opts.userId, useCase: "surface", result: res as Parameters<typeof trackModelCall>[0]["result"] });
    }
    const framed = res.content.trim();
    return framed || opts.result;
  } catch (e) {
    // Framing is best-effort — never drop a surfaced result because it couldn't
    // be reworded. Log and fall back to the raw content.
    getLogger().warn({ err: e }, "surface framing failed; surfacing raw result");
    return opts.result;
  }
}
