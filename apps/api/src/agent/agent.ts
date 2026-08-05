import {
  AGENT_DEDUP_THRESHOLD,
  callEmbeddings,
  callOpenRouter,
  getLogger,
  getPrismaClient,
  loadPrompt,
  trackModelCall,
} from "@mimir/backend-core";
import type { LlmMessage } from "@mimir/shared-types";

const prisma = getPrismaClient();

export type ClassificationAction =
  | "answer_directly"
  | "spawn_agent"
  | "manage_cancel"
  | "manage_list"
  | "ask_clarification";

export interface Classification {
  action: ClassificationAction;
  targetAgentId?: string;
  taskDescription?: string;
  targetHint?: string;
  confidence: number;
}

// Actions that must NEVER carry a targetAgentId (a cancel must not become a
// retarget/resume). Defensive: even if the model emits one, we strip it.
const NO_TARGET_ACTIONS: ClassificationAction[] = ["manage_cancel", "manage_list", "ask_clarification", "answer_directly"];

export const ANSWER_DIRECTLY: Classification = { action: "answer_directly", confidence: 0 };

// Structured JSON output {action, targetAgentId, taskDescription, confidence}.
// Plain JSON prompt + parse, not tool-calls — the OpenRouter wrapper has no tool
// support and parse failure falls back to answer_directly.
const CLASSIFICATION_SYSTEM = loadPrompt("classification.md");
const REWRITE_SYSTEM = loadPrompt("rewrite.md");

// Context resolution (A): before classification runs, fold the recent
// conversation into a self-contained query so anaphora ("it", "that thing")
// and corrections resolve. The history is capped by a rough token budget (not
// turn count) so a few long turns can't blow past it cheaply.
const REWRITE_HISTORY_BUDGET_TOKENS = 800;

export function rewriteHistoryContext(history: { role: string; content: string }[]): string {
  if (history.length === 0) return "(no prior conversation)";
  // Rough token estimate: ~4 chars/token.
  let budget = REWRITE_HISTORY_BUDGET_TOKENS * 4;
  const kept: string[] = [];
  // Keep the most recent turns first, within budget.
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn) continue;
    const line = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`;
    if (line.length > budget) {
      if (kept.length === 0) kept.push(line.slice(-budget));
      break;
    }
    kept.unshift(line);
    budget -= line.length;
  }
  return kept.join("\n");
}

export function parseRewrite(raw: string, fallback: string): string {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned) as { rewritten?: unknown };
    if (typeof json.rewritten === "string" && json.rewritten.trim().length > 0) {
      return json.rewritten.trim();
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export async function rewriteQuery(userId: string, history: { role: string; content: string }[], content: string): Promise<string> {
  const context = rewriteHistoryContext(history);
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: REWRITE_SYSTEM },
        { role: "user", content: `Conversation so far:\n${context}\n\nLatest user message: ${content}` },
      ],
      { useCase: "classification" },
    );
  } catch (e) {
    getLogger().warn({ err: e }, "query rewrite failed; classifying raw message");
    await trackModelCall({ userId, useCase: "classification", error: (e as Error)?.message ?? String(e) });
    return content;
  }
  await trackModelCall({ userId, useCase: "classification", result });
  return parseRewrite(result.content, content);
}


export async function classifyMessage(userId: string, content: string, activeAgents: { id: string; taskDescription: string }[]): Promise<Classification> {
  const roster =
    activeAgents.length === 0
      ? "(no active agents)"
      : activeAgents.map((a) => `- ${a.id}: ${a.taskDescription}`).join("\n");
  const messages: LlmMessage[] = [
    { role: "system", content: `${CLASSIFICATION_SYSTEM}\n\nActive agents:\n${roster}` },
    { role: "user", content },
  ];
  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "classification" });
  } catch (e) {
    getLogger().error({ err: e }, "classification call failed; answering directly");
    await trackModelCall({ userId, useCase: "classification", error: (e as Error)?.message ?? String(e) });
    return ANSWER_DIRECTLY;
  }
  await trackModelCall({ userId, useCase: "classification", result });
  return parseClassification(result.content);
}

// Parse failure or confidence < 0.5 => answer_directly.
export function parseClassification(raw: string): Classification {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    const rawAction = String(json.action ?? "").trim() as ClassificationAction;
    const action: ClassificationAction =
      rawAction === "spawn_agent" ||
      rawAction === "manage_cancel" ||
      rawAction === "manage_list" ||
      rawAction === "ask_clarification"
        ? rawAction
        : "answer_directly";
    const confidence = typeof json.confidence === "number" ? json.confidence : 0;
    if (action === "answer_directly") return ANSWER_DIRECTLY;
    // Confidence gates only the state-creating action (spawn_agent). A cancel /
    // list / clarify must still act even when the model is unsure — gating it
    // here degrades a "stop" into a chat reply and leaves the watch running (the
    // exact bug the management feature exists to fix). These intents are
    // non-destructive: archiveAgents never wipes state on a specific miss, so a
    // low-confidence classification can't nuke unrelated watches.
    if (action === "spawn_agent" && confidence < 0.5) return ANSWER_DIRECTLY;
    // Cancel/list/clarify never resolve to an existing agent — strip any bogus
    // targetAgentId the model might emit so message.ts cannot retarget it.
    const targetAgentId =
      !NO_TARGET_ACTIONS.includes(action) && typeof json.targetAgentId === "string"
        ? json.targetAgentId
        : undefined;
    const taskDescription = typeof json.taskDescription === "string" ? json.taskDescription : undefined;
    const targetHint = typeof json.targetHint === "string" ? json.targetHint : undefined;
    return { action, targetAgentId, taskDescription, targetHint, confidence };
  } catch {
    return ANSWER_DIRECTLY;
  }
}

// text-embedding-3-small via OpenRouter (no separate key).
export async function embedTask(taskDescription: string): Promise<number[]> {
  const vector = await callEmbeddings(taskDescription);
  if (vector.length === 0) throw new Error("empty embedding returned");
  return vector;
}

// pgvector cosine similarity against the user's ACTIVE agents, threshold 0.85.
// Split embed (network) from query so the SQL is testable without a live model call.
// Returns the computed embedding so callers (spawn path) can reuse it instead of
// paying for a second embed call.
export async function findDuplicateAgent(userId: string, taskDescription: string): Promise<{ duplicate: { id: string; taskDescription: string; similarity: number } | null; embedding: number[] | null }> {
  let embedding: number[];
  try {
    embedding = await embedTask(taskDescription);
  } catch (e) {
    // ponytail: dedup is best-effort; a failed embed degrades to no-match (spawn proceeds).
    getLogger().warn({ err: e }, "embedding failed; skipping dedup");
    return { duplicate: null, embedding: null };
  }
  return { duplicate: await findDuplicateByVector(userId, embedding), embedding };
}

export async function findDuplicateByVector(userId: string, embedding: number[]): Promise<{ id: string; taskDescription: string; similarity: number } | null> {
  const vec = `[${embedding.join(",")}]`;
  const rows = await prisma.$queryRaw<{ id: string; taskDescription: string; similarity: number }[]>`
    SELECT id, "taskDescription", 1 - (embedding <=> ${vec}::vector) AS similarity
    FROM "Agent"
    WHERE "userId" = ${userId} AND status = 'active' AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 1
  `;
  const top = rows[0];
  if (!top || top.similarity < AGENT_DEDUP_THRESHOLD) return null;
  return top;
}

// Single tx — insert Agent + insert OutboxEvent. Returns the spawned agent id.
export async function spawnAgent(opts: {
  userId: string;
  ownerConversationId: string;
  taskDescription: string;
  embedding: number[];
  context?: string;
}): Promise<{ agentId: string }> {
  const vec = `[${opts.embedding.join(",")}]`;
  const agentId = await prisma.$transaction(async (tx) => {
    const agent = await tx.agent.create({
      data: {
        userId: opts.userId,
        ownerConversationId: opts.ownerConversationId,
        taskDescription: opts.taskDescription,
        // The worker only fetches Gmail when the entity OR task mentions
        // email/mail (gmail.ts's own guard); hardcoding "gmail" made every
        // spawned agent — including web-search watches — hit Gmail and surface
        // a bogus "Connect Gmail" prompt when unconnected. Derive it here.
        entity: /email|mail/i.test(opts.taskDescription) ? "gmail" : "browser",
      },
    });
    // embedding column is Unsupported in Prisma — raw write only.
    await tx.$executeRaw`UPDATE "Agent" SET embedding = ${vec}::vector WHERE id = ${agent.id}`;
    await tx.outboxEvent.create({
      data: {
        eventType: "spawn_agent",
        payload: { agentId: agent.id, trigger: "user_message", context: opts.context },
      },
    });
    return agent.id;
  });
  return { agentId };
}

export async function listActiveAgents(userId: string): Promise<{ id: string; taskDescription: string }[]> {
  return prisma.agent.findMany({
    where: { userId, status: "active" },
    select: { id: true, taskDescription: true },
    orderBy: { lastActiveAt: "desc" },
  });
}

// Cancel/mgmt: archive matching active agents and disable their triggers.
// Empty or fully-generic hint ("stop all monitoring", "clear all notes")
// cancels EVERYTHING. Scoped to this user only. Returns ids archived.
export async function archiveAgents(userId: string, hint?: string): Promise<{ archived: string[] }> {
  const active = await prisma.agent.findMany({ where: { userId, status: "active" } });
  if (active.length === 0) return { archived: [] };

  let targets = active;
  const rawHint = hint?.trim() ?? "";
  if (rawHint.length > 0) {
    // Distinctive tokens = hint words minus stopwords and generic background
    // nouns. A token match is "any distinctive token appears in the task", so a
    // paraphrase hint like "the alice watch" still hits the alice watch even
    // though the word "the" isn't in its description.
    const GENERIC = new Set([
      "the","a","an","and","for","from","to","of","my","your","all","any","this","that","those","these","its","it",
      "watch","watches","watchers","check","checks","monitor","monitors","look","email","mail","mails","emails",
      "messages","notify","notification","notifications","remind","reminder","reminders","note","notes",
      "alert","alerts","update","updates","trigger","triggers","agent","agents","active","currently","about",
      "related","things","stuff","monitoring","background",
      "sticky","keep","going","ongoing","something","everything","nothing",
      "stop","cancel","remove","delete","forget","end","halt","pause","cease","kill","quit","now","please","right",
      "away","immediately","today","yesterday",
      // Common function/auxiliary words must not count as "distinctive" — a
      // phrase like "the one you set up" would otherwise over-match any agent
      // containing one of them ("set"/"you") and archive it.
      "you","your","she","he","we","us","them","their","its","it","up","down","off","on","at","by","with","when",
      "what","where","who","how","does","did","do","have","has","had","get","got","just","can","could","would","will",
    ]);
    const hy = rawHint.toLowerCase();
    const tokens = hy.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));
    // Whether the hint carried ANY distinctive token. A distinctive-but-unmatched
    // hint is almost certainly a miss (a typo, or a reference to something already
    // archived). Blanket hints ("stop everything") leave no distinctive tokens.
    const hasDistinctive = tokens.length > 0;
    targets = active.filter((a) => {
      const desc = (a.taskDescription ?? "").toLowerCase();
      const id = (a.id ?? "").toLowerCase();
      if (desc.includes(hy) || id.includes(hy)) return true;
      // Tokens are distinctive — match on word boundaries so a common substring
      // ("rent") can't over-match an unrelated agent ("rental").
      if (tokens.length > 0 && tokens.some((tok) => new RegExp(`\\b${tok}\\b`).test(desc))) return true;
      return false;
    });
    // Never a silent no-op. Two cases:
    //  - A specific hint that matched nothing is a MISS: archive nothing. Wiping
    //    every unrelated watch because of a typo is a destructive foot-gun, and
    //    message.ts tells the user nothing matched instead.
    //  - A genuinely blanket hint (no distinctive tokens left) fails open to
    //    cancelling everything, so "stop -> keeps watching" can't recur.
    if (targets.length === 0 && hasDistinctive) {
      getLogger().info({ userId, hint: rawHint }, "archive: specific hint matched nothing; archiving none");
      return { archived: [] };
    }
    if (targets.length === 0) {
      getLogger().info({ userId, hint: rawHint }, "archive: blanket hint; cancelling all active agents");
      targets = active;
    }
  }
  const ids = targets.map((a) => a.id);
  if (ids.length === 0) return { archived: [] };
  await prisma.$transaction([
    // Disable the associated triggers first so the 1-min tick won't fire them.
    prisma.trigger.updateMany({ where: { agentId: { in: ids }, enabled: true }, data: { enabled: false } }),
    prisma.agent.updateMany({ where: { id: { in: ids }, status: "active" }, data: { status: "archived" } }),
  ]);
  return { archived: ids };
}

// List view for manage_list: active agents with their enabled triggers.
export async function listActiveWithTriggers(userId: string): Promise<{ id: string; taskDescription: string; triggers: { id: string; name: string; criteria: string; enabled: boolean }[] }[]> {
  const agents = await prisma.agent.findMany({
    where: { userId, status: "active" },
    select: { id: true, taskDescription: true, triggers: { where: { enabled: true }, select: { id: true, name: true, criteria: true, enabled: true } } },
    orderBy: { lastActiveAt: "desc" },
  });
  return agents;
}

// Cheap-model extraction of an implicit "watch-for" trigger from a spawn request
// (4.11). Runs alongside spawn; a detected trigger gets its own Trigger row so
// the 1-min scheduler can fire the agent without a user in the loop.
export interface TriggerProposal {
  hasTrigger: boolean;
  name?: string;
  criteria?: string;
}

export const NO_TRIGGER: TriggerProposal = { hasTrigger: false };

const TRIGGER_SYSTEM = loadPrompt("trigger_extract.md");

export async function classifyTrigger(userId: string, content: string, taskDescription: string): Promise<TriggerProposal> {
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: TRIGGER_SYSTEM },
        { role: "user", content: `User request: ${content}\nAgent task: ${taskDescription}` },
      ],
      { useCase: "classification" },
    );
  } catch (e) {
    getLogger().warn({ err: e }, "trigger classification failed; proceeding without trigger");
    await trackModelCall({ userId, useCase: "classification", error: (e as Error)?.message ?? String(e) });
    return NO_TRIGGER;
  }
  await trackModelCall({ userId, useCase: "classification", result });
  return parseTriggerProposal(result.content);
}

export function parseTriggerProposal(raw: string): TriggerProposal {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { hasTrigger?: unknown; name?: unknown; criteria?: unknown };
    if (json.hasTrigger !== true || typeof json.criteria !== "string" || json.criteria.length === 0) return NO_TRIGGER;
    return {
      hasTrigger: true,
      name: typeof json.name === "string" ? json.name : "trigger",
      criteria: json.criteria,
    };
  } catch {
    return NO_TRIGGER;
  }
}
