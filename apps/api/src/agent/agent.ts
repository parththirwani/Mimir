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

export type ClassificationAction = "answer_directly" | "spawn_agent";

export interface Classification {
  action: ClassificationAction;
  targetAgentId?: string;
  taskDescription?: string;
  confidence: number;
}

export const ANSWER_DIRECTLY: Classification = { action: "answer_directly", confidence: 0 };

// Structured JSON output {action, targetAgentId, taskDescription, confidence}.
// Plain JSON prompt + parse, not tool-calls — the OpenRouter wrapper has no tool
// support and parse failure falls back to answer_directly.
const CLASSIFICATION_SYSTEM = loadPrompt("classification.md");

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
    const action: ClassificationAction = json.action === "spawn_agent" ? "spawn_agent" : "answer_directly";
    const confidence = typeof json.confidence === "number" ? json.confidence : 0;
    if (action === "answer_directly" || confidence < 0.5) return ANSWER_DIRECTLY;
    const targetAgentId = typeof json.targetAgentId === "string" ? json.targetAgentId : undefined;
    const taskDescription = typeof json.taskDescription === "string" ? json.taskDescription : undefined;
    return { action, targetAgentId, taskDescription, confidence };
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
