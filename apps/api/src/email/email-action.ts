import {
  callOpenRouter,
  getConfig,
  getLogger,
  getPrismaClient,
  loadPrompt,
  trackModelCall,
} from "@mimir/backend-core";
import { GMAIL_INTEGRATION, NangoConnectionProvider } from "@mimir/connection-provider";
import type { LlmMessage } from "@mimir/shared-types";
import { createGmailDraft, getGmailProfile } from "../../../worker/src/integrations/gmail/gmail.js";

const prisma = getPrismaClient();

export const EMAIL_ACTION_TYPE = "gmail.send_email";
export const EMAIL_TO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 20000;
// Cheap gate so the extra LLM call only runs on plausibly-email messages.
export const EMAIL_HINT_RE = /email|mail|write to|draft|reply to/i;

export type EmailActionProposal = { intent: "send_email"; to: string; subject: string; body: string } | { intent: "none" };
export type ResolveIntent = "confirm" | "cancel" | "ambiguous" | "unrelated";

export interface PendingEmailAction {
  messageId: string;
  draftId: string;
  draft: { to: string; subject: string; body: string };
}

export function emailActionHint(content: string): boolean {
  return EMAIL_HINT_RE.test(content);
}

// Real connection state, not just "a row exists": heal a missing local row from
// Nango first (same reconciliation as GET /integrations/gmail), and treat an
// expired row as disconnected so the user is prompted to reconnect before work.
export async function isGmailConnected(userId: string): Promise<boolean> {
  const provider = gmailProvider();
  let connection = await provider.getConnection(userId);
  if (!connection) {
    try {
      await provider.syncConnection(userId);
    } catch (e) {
      getLogger().warn({ err: e, userId }, "gmail reconciliation failed");
    }
    connection = await provider.getConnection(userId);
  }
  return connection != null && connection.status !== "expired";
}

// The pending draft is carried on the confirmation Message's toolCalls column —
// no schema change; the Message history doubles as the send/cancel audit trail.
export async function findPendingEmailAction(conversationId: string): Promise<PendingEmailAction | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", status: "complete" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const row of rows) {
    const t = row.toolCalls as { type?: string; status?: string; draftId?: string; draft?: { to?: string; subject?: string; body?: string } } | null;
    if (t && t.type === EMAIL_ACTION_TYPE && t.status === "pending" && t.draftId && t.draft) {
      return {
        messageId: row.id,
        draftId: t.draftId,
        draft: { to: t.draft.to ?? "", subject: t.draft.subject ?? "", body: t.draft.body ?? "" },
      };
    }
  }
  return null;
}

export async function markEmailAction(messageId: string, status: "executed" | "cancelled", extra: Record<string, unknown> = {}): Promise<void> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { toolCalls: true } });
  const t = (row?.toolCalls ?? {}) as Record<string, unknown>;
  await prisma.message.update({ where: { id: messageId }, data: { toolCalls: { ...t, status, ...extra } } });
}

// A new draft supersedes any older pending one in the same conversation — the
// old draft stays in Gmail Drafts (cancel semantics), the chat action is void.
export async function cancelPendingEmailActions(conversationId: string): Promise<void> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", status: "complete" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const row of rows) {
    const t = row.toolCalls as { type?: string; status?: string } | null;
    if (t && t.type === EMAIL_ACTION_TYPE && t.status === "pending") {
      await markEmailAction(row.id, "cancelled");
    }
  }
}

// Structured LLM call — same pattern as classifyMessage/filterVerdict: plain
// JSON in, parse-or-safely-ignore out. A parse failure must never block chat.
const PROPOSE_SYSTEM = loadPrompt("email_propose.md");

export async function proposeEmailAction(
  userId: string,
  history: LlmMessage[],
  gmailState: "connected" | "not_connected" = "connected",
): Promise<EmailActionProposal> {
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: PROPOSE_SYSTEM },
        { role: "system", content: `User's Gmail connection status: ${gmailState}.` },
        ...history,
      ],
      { useCase: "email_proposal" },
    );
  } catch (e) {
    getLogger().error({ err: e }, "email proposal call failed; continuing without email action");
    await trackModelCall({ userId, useCase: "email_proposal", error: (e as Error)?.message ?? String(e) });
    return { intent: "none" };
  }
  await trackModelCall({ userId, useCase: "email_proposal", result });
  return parseEmailAction(result.content);
}

export function parseEmailAction(raw: string): EmailActionProposal {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { intent?: unknown; to?: unknown; subject?: unknown; body?: unknown };
    if (json.intent !== "send_email") return { intent: "none" };
    return {
      intent: "send_email",
      to: typeof json.to === "string" ? json.to.trim() : "",
      subject: typeof json.subject === "string" ? json.subject : "",
      body: typeof json.body === "string" ? json.body : "",
    };
  } catch {
    return { intent: "none" };
  }
}

const RESOLVE_SYSTEM = (draft: { to: string; subject: string }) =>
  loadPrompt("email_resolve.md").replace("{to}", draft.to).replace("{subject}", draft.subject);

export async function resolvePendingAction(userId: string, content: string, draft: { to: string; subject: string }): Promise<ResolveIntent> {
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: RESOLVE_SYSTEM(draft) },
        { role: "user", content },
      ],
      { useCase: "email_resolve" },
    );
  } catch (e) {
    getLogger().warn({ err: e }, "email resolve call failed; treating as ambiguous");
    await trackModelCall({ userId, useCase: "email_resolve", error: (e as Error)?.message ?? String(e) });
    return "ambiguous";
  }
  await trackModelCall({ userId, useCase: "email_resolve", result });
  return parseResolveIntent(result.content);
}

export function parseResolveIntent(raw: string): ResolveIntent {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { intent?: unknown };
    if (json.intent === "confirm" || json.intent === "cancel" || json.intent === "unrelated") return json.intent;
    return "ambiguous";
  } catch {
    return "ambiguous";
  }
}

export function gmailProvider(): NangoConnectionProvider {
  const cfg = getConfig();
  return new NangoConnectionProvider({
    secretKey: cfg.NANGO_SECRET_KEY,
    host: cfg.NANGO_BASE_URL,
    store: prisma.integrationConnection,
  });
}

export async function createEmailDraft(userId: string, draft: { to: string; subject: string; body: string }): Promise<{ draftId: string; messageId: string }> {
  const token = await gmailProvider().getAccessToken(userId);
  const from = await getGmailProfile(token);
  const created = await createGmailDraft(token, { from, ...draft });
  return { draftId: created.id, messageId: created.messageId };
}

// Same fail-fast handling as agent-execution: an expired/revoked token flips the
// connection row so the UI offers reconnect, and the pending draft is kept so the
// user can confirm again after reconnecting. Provider errors bubble to the caller.
export async function markGmailExpired(userId: string): Promise<void> {
  await prisma.integrationConnection.updateMany({
    where: { userId, provider: GMAIL_INTEGRATION },
    data: { status: "expired" },
  });
}
