import {
  generateAck,
  getConfig,
  getLogger,
  getPrismaClient,
  trackEvent,
} from "@mimir/backend-core";
import { ConnectionError, GMAIL_INTEGRATION, gmailProvider as gmailProviderOf } from "@mimir/connection-provider";
import type { Job } from "bullmq";
import { sendGmailDraft } from "../integrations/gmail/gmail.js";
import { publishUserEvent } from "../infra/redis.js";

// The email-jobs processor: the API's confirm path enqueues an email_send
// outbox row and returns the "sending now" ack immediately; this job performs
// the real Gmail send and writes+publishes the result. Self-contained (no
// worker->api import) — it re-implements the few prisma helpers it needs.
const prisma = getPrismaClient();

function gmailProvider(): ReturnType<typeof gmailProviderOf> {
  const cfg = getConfig();
  return gmailProviderOf(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
}

async function markGmailExpired(userId: string): Promise<void> {
  await prisma.integrationConnection.updateMany({
    where: { userId, provider: GMAIL_INTEGRATION },
    data: { status: "expired" },
  });
}

async function markEmailAction(messageId: string, status: "executed" | "cancelled", extra: Record<string, unknown> = {}): Promise<void> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { toolCalls: true } });
  const t = (row?.toolCalls ?? {}) as Record<string, unknown>;
  await prisma.message.update({ where: { id: messageId }, data: { toolCalls: { ...t, status, ...extra } } });
}

// Postgres write first, publish after — same ordering rule as agent-execution.
async function writeAndPublish(opts: {
  userId: string;
  conversationId: string;
  parentMessageId: string;
  content: string;
  toolCalls?: { type: string; status: string };
}): Promise<void> {
  const message = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      role: "assistant",
      content: opts.content,
      status: "complete",
      parentMessageId: opts.parentMessageId,
      toolCalls: opts.toolCalls,
    },
  });
  try {
    await publishUserEvent(opts.userId, "new_message", { conversationId: opts.conversationId, messageId: message.id });
  } catch (e) {
    getLogger().error({ err: e, userId: opts.userId }, "email send publish failed (message already written)");
  }
}

export async function sendEmailJob(job: Job): Promise<void> {
  const { userId, draftId, messageId, conversationId, to, subject, parentMessageId } = job.data as {
    userId: string;
    draftId: string;
    messageId: string;
    conversationId: string;
    to: string;
    subject: string;
    parentMessageId: string;
  };
  getLogger().info({ userId, draftId, jobId: job.id }, "email send job started");

  let sentId: string;
  try {
    const token = await gmailProvider().getAccessToken(userId);
    sentId = await sendGmailDraft(token, draftId);
  } catch (e) {
    if (e instanceof ConnectionError) {
      // Fail-fast like agent-execution: flip the connection row so the UI offers
      // reconnect, surface a connect message (with button), and leave the draft
      // pending so a re-confirm after reconnecting works.
      getLogger().warn({ err: e, userId }, "email send blocked by expired gmail token");
      await markGmailExpired(userId);
      await writeAndPublish({
        userId,
        conversationId,
        parentMessageId,
        content: "Your Gmail connection expired. Reconnect Gmail, then tell me to send the draft again.",
        toolCalls: { type: "gmail.connect", status: "pending" },
      });
      return;
    }
    // Terminal failure (retries exhausted): never mark executed — the draft stays
    // pending so the user can re-confirm. Tell them, then rethrow for the DLQ.
    getLogger().error({ err: e, userId, draftId }, "email send failed; draft kept pending");
    const content = await generateAck("send_failed", {
      context: `sending the email to ${to}`,
      fallback: `The email couldn't be sent right now. It's still in your Gmail drafts — try again in a moment.`,
      userId,
    });
    await writeAndPublish({ userId, conversationId, parentMessageId, content });
    throw e;
  }

  await markEmailAction(messageId, "executed", { sentMessageId: sentId });
  await trackEvent(userId, "email_sent", { conversationId, draftId, to, subject });
  const content = await generateAck("send_result", {
    context: `the email to ${to} with subject "${subject}" was just sent`,
    fallback: `Sent to ${to}: "${subject}".`,
    userId,
  });
  await writeAndPublish({ userId, conversationId, parentMessageId, content });
  getLogger().info({ userId, draftId, sentId }, "email send completed");
}
