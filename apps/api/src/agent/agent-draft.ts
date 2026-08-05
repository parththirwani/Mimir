import { callOpenRouter, getLogger, getPrismaClient, trackModelCall } from "@mimir/backend-core";

// Pending draft tool resolution for 4.10: the execution agent inserts verbatim
// content (an email draft, a reply, etc.) into the thread with
// toolCalls{type:"agent.draft",status:"pending"}. The user's next message
// resolves confirm/cancel/ambiguous via the same structured-LLM pattern as
// email-action, and a confirm re-triggers the SAME agent with the draft as
// context (the outbox relay enqueues the agent job unchanged).

const prisma = getPrismaClient();

export const AGENT_DRAFT_TYPE = "agent.draft";

export interface PendingAgentDraft {
  messageId: string;
  agentId: string;
  actionLabel: string;
  draft: { content: string };
}

export async function findPendingAgentDraft(conversationId: string): Promise<PendingAgentDraft | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", status: "complete" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const row of rows) {
    const t = row.toolCalls as
      | { type?: string; status?: string; agentId?: string; actionLabel?: string; draft?: { content?: string } }
      | null;
    if (t && t.type === AGENT_DRAFT_TYPE && t.status === "pending" && t.agentId && t.draft?.content) {
      return {
        messageId: row.id,
        agentId: t.agentId,
        actionLabel: t.actionLabel ?? "",
        draft: { content: t.draft.content },
      };
    }
  }
  return null;
}

export async function markAgentDraft(messageId: string, status: "executed" | "cancelled", extra: Record<string, unknown> = {}): Promise<void> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { toolCalls: true } });
  const t = (row?.toolCalls ?? {}) as Record<string, unknown>;
  await prisma.message.update({ where: { id: messageId }, data: { toolCalls: { ...t, status, ...extra } } });
}

export type DraftResolveIntent = "confirm" | "cancel" | "ambiguous" | "unrelated";

const RESOLVE_SYSTEM = (label: string) => [
  "You decide whether a user's message confirms or cancels a pending draft the assistant proposed.",
  `Pending draft action: ${label || "act on the draft"}.`,
  'Respond with STRICT JSON only: {"intent":"confirm"|"cancel"|"ambiguous"|"unrelated"}.',
  "confirm: the user approves proceeding with the draft. cancel: the user declines (the draft stays).",
  "ambiguous: unclear whether to proceed or cancel. unrelated: the message has nothing to do with the draft.",
].join("\n");

export async function resolveAgentDraft(userId: string, content: string, label: string): Promise<DraftResolveIntent> {
  let result;
  try {
    result = await callOpenRouter(
      [{ role: "system", content: RESOLVE_SYSTEM(label) }, { role: "user", content }],
      { useCase: "email_resolve" },
    );
  } catch (e) {
    getLogger().warn({ err: e }, "agent draft resolve call failed; treating as ambiguous");
    await trackModelCall({ userId, useCase: "email_resolve", error: (e as Error)?.message ?? String(e) });
    return "ambiguous";
  }
  await trackModelCall({ userId, useCase: "email_resolve", result });
  return parseDraftResolveIntent(result.content);
}

export function parseDraftResolveIntent(raw: string): DraftResolveIntent {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { intent?: unknown };
    if (json.intent === "confirm" || json.intent === "cancel" || json.intent === "unrelated") return json.intent;
    return "ambiguous";
  } catch {
    return "ambiguous";
  }
}
