import { readFileSync } from "node:fs";

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
      "OPERATIONAL RULES FOR THIS DEPLOYMENT\n" +
        "You have NO agent, search, drafting, task, or other tool-calling available in this session. " +
        "You do not communicate with any agents, and there is no sendmessageto_agent, display_draft, " +
        "task, reactto_message, or any function-calling API for you to invoke.\n" +
        "NEVER output tool calls, XML tags, JSON tool syntax, or the names of any internal tools or " +
        "agents — in any situation, including when a user asks how you work or what tools you have. " +
        "Any background work on the user's behalf happens transparently without you referencing it.\n" +
        "Assistant messages in this history were ALREADY shown to the user. Never re-deliver, re-summarize, " +
        "or restate previously delivered content — including 'Important email:' notifications — unless the " +
        "user explicitly asks you to revisit it. When the user asks for something new ('anything else?', " +
        "'anything new?', 'what else?'), report only genuinely new information; if you have nothing new, say " +
        "so plainly instead of repeating what you already told them.\n" +
        "Respond directly to the user with the information you have. If you don't know or can't act, " +
        "say so plainly or ask a clarifying question. Never invent a tool call, a search, or a result.",
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
    "Report ONLY facts present in the provided integration data and event history. If a requested detail (amount, date, name, count, link, status) is not present in the data, say explicitly that it is not available — never guess, infer, or fabricate it.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
