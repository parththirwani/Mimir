import {
  getLogger,
  getPrismaClient,
  callOpenRouter,
  trackEvent,
  trackModelCall,
  backfillCost,
  rollDailyUsage,
  chatSystemPrompt,
  searchActiveFacts,
} from "@mimir/backend-core";
import { messageSchema } from "@mimir/zod-schemas";
import { ConnectionError } from "@mimir/connection-provider";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";
import { mapLLMError } from "../infra/errors.js";
import {
  EMAIL_ACTION_TYPE,
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  EMAIL_TO_RE,
  cancelPendingEmailActions,
  createEmailDraft,
  deleteEmailDraft,
  emailActionHint,
  findPendingEmailAction,
  isGmailConnected,
  markEmailAction,
  markGmailExpired,
  proposeEmailAction,
  resolvePendingAction,
} from "../email/email-action.js";
import { writeAck } from "../agent/ack.js";
import {
  classifyMessage,
  classifyTrigger,
  archiveAgents,
  listActiveAgents,
  listActiveWithTriggers,
  embedTask,
  findDuplicateAgent,
  rewriteQuery,
  spawnAgent,
} from "../agent/agent.js";
import {
  findPendingAgentDraft,
  markAgentDraft,
  resolveAgentDraft,
} from "../agent/agent-draft.js";

const prisma = getPrismaClient();

const messageRouter: Router = Router();

// Reply context window: the payload is newest-first from the DB query
// (orderBy createdAt desc, take 50). Keep the newest N and return them
// oldest->newest — the shape the reply call consumes.
export function lastNMessages<T>(messages: T[], n = 50): T[] {
  return messages.slice(0, n).reverse();
}

// Only query durable facts once the reply window filled up
// (history.length === windowSize means the DB take was capped, i.e. the thread
// actually has >= windowSize messages). Below that the full history is already in
// context and a fact-retrieval call (embed + pgvector query) buys nothing.
export function shouldFetchFacts(historyLength: number, windowSize = 50): boolean {
  return historyLength >= windowSize;
}

// Render retrieved facts as a system context block, or null when there's
// nothing to inject (empty result / fail-open reads return []).
export function factContextBlock(facts: { subject: string; fact: string }[]): string | null {
  if (facts.length === 0) return null;
  return `Relevant facts from earlier in this thread:\n${facts.map((f) => `- ${f.subject}: ${f.fact}`).join("\n")}`;
}

// POST /api/v1/message
messageRouter.post("/message", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid message payload" } });
    return;
  }
  const { conversationId, content, clientMessageId } = parsed.data;

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.userId !== userId) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Conversation not found" } });
    return;
  }

  // Idempotency: the unique (conversationId, clientMessageId) constraint is the arbiter.
  let userMsg;
  let isRetry = false;
  let existing: { id: string } | null = null;
  existing = await prisma.message.findUnique({
    where: { conversationId_clientMessageId: { conversationId, clientMessageId } },
  });
  if (!existing) {
    try {
      userMsg = await prisma.message.create({
        data: {
          conversationId,
          clientMessageId,
          role: "user",
          content,
          status: "complete",
        },
      });
    } catch (e) {
      // concurrent/duplicate insert raced us: read what won
      if ((e as { code?: string }).code === "P2002") {
        isRetry = true;
        existing = await prisma.message.findUnique({
          where: { conversationId_clientMessageId: { conversationId, clientMessageId } },
        });
        userMsg = existing;
      } else {
        throw e;
      }
    }
  } else {
    isRetry = true;
    userMsg = existing;
  }
  if (!userMsg) {
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Failed to record message" } });
    return;
  }
  getLogger().info(
    { conversationId, clientMessageId, isRetry },
    isRetry ? "user message replayed (idempotent hit)" : "user message recorded",
  );
  await trackEvent(userId, "chat_message_sent", { conversationId, isRetry, contentLength: content.length });

  // A completed retry returns the stored result without a second LLM call.
  if (isRetry) {
    const reply = await prisma.message.findFirst({
      where: { parentMessageId: userMsg.id },
      orderBy: { createdAt: "asc" },
    });
    if (reply && reply.status === "complete") {
      res.status(200).json({
        message: {
          id: reply.id,
          conversationId,
          role: "assistant",
          content: reply.content,
          createdAt: reply.createdAt,
          promptTokens: reply.promptTokens,
          completionTokens: reply.completionTokens,
          totalTokens: reply.tokenCount,
          durationMs: reply.durationMs,
        },
        usage: {
          promptTokens: reply.promptTokens ?? 0,
          completionTokens: reply.completionTokens ?? 0,
          totalTokens: reply.tokenCount ?? 0,
        },
        latencyMs: reply.durationMs,
      });
      return;
    }
  }

  // A pending email draft forces resolution before any new work — send, cancel,
  // or ask again. Deliberate: the draft stays pending until decided, and every
  // message is intercepted in the meantime (buttons and typed replies both land
  // here). No regex guessing on intent: the same structured-LLM pattern as the
  // interaction-agent classification decides confirm/cancel/ambiguous/unrelated.
  const pendingAction = await findPendingEmailAction(conversationId);
  if (pendingAction) {
    const resolved = await resolvePendingAction(userId, content, pendingAction.draft);
    let replyContent: string;
    if (resolved.intent === "confirm") {
      // Async send: the acknowledgment returns immediately, the actual Gmail
      // send runs as an outbox->worker job that writes the "Sent" result and
      // pushes it via socket. The draft stays pending until the worker marks it
      // executed — a failed job leaves it pending so the user can re-confirm.
      const ack = await writeAck({
        userId,
        conversationId,
        parentMessageId: userMsg.id,
        kind: "send",
        context: `send the pending email draft to ${pendingAction.draft.to} ("${pendingAction.draft.subject}")`,
      });
      await prisma.outboxEvent.create({
        data: {
          eventType: "email_send",
          payload: {
            userId,
            draftId: pendingAction.draftId,
            messageId: pendingAction.messageId,
            conversationId,
            to: pendingAction.draft.to,
            subject: pendingAction.draft.subject,
            parentMessageId: userMsg.id,
          },
        },
      });
      await trackEvent(userId, "email_send_enqueued", {
        conversationId,
        draftId: pendingAction.draftId,
        to: pendingAction.draft.to,
        subject: pendingAction.draft.subject,
      });
      res.status(200).json(ack);
      return;
    } else if (resolved.intent === "cancel") {
      await markEmailAction(pendingAction.messageId, "cancelled");
      await trackEvent(userId, "email_cancelled", {
        conversationId,
        draftId: pendingAction.draftId,
        to: pendingAction.draft.to,
        subject: pendingAction.draft.subject,
      });
      replyContent = "Cancelled — the email stays in your Gmail drafts if you want to edit it there.";
    } else if (resolved.intent === "edit" && resolved.draft) {
      // The user is changing a mail detail (recipient/subject/body), not
      // deciding to send. Validate, re-draft, and re-show the updated email for
      // confirmation instead of forcing send/cancel.
      const d = resolved.draft;
      let check: { ok: boolean; replyContent: string } = { ok: true, replyContent: "" };
      if (!EMAIL_TO_RE.test(d.to) || !d.subject || !d.body) {
        check = { ok: false, replyContent: "I still need a valid recipient and the full message — could you give me those?" };
      } else if (d.subject.length > EMAIL_SUBJECT_MAX || d.body.length > EMAIL_BODY_MAX) {
        check = { ok: false, replyContent: "That draft is too long. Could you shorten it?" };
      }
      if (!check.ok) {
        const msg = await prisma.message.create({
          data: { conversationId, role: "assistant", content: check.replyContent, status: "complete", parentMessageId: userMsg.id },
        });
        res.status(200).json({
          message: { id: msg.id, conversationId, role: "assistant", content: msg.content, createdAt: msg.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      await cancelPendingEmailActions(conversationId);
      await trackEvent(userId, "email_draft_edited", {
        conversationId,
        oldTo: pendingAction.draft.to,
        to: d.to,
        subject: d.subject,
      });
      let draft;
      try {
        draft = await createEmailDraft(userId, { to: d.to, subject: d.subject, body: d.body });
      } catch (e) {
        // Only the pending chat action was un-pended; the old Gmail draft is
        // still there, so a failed re-draft doesn't destroy the user's copy.
        getLogger().error({ err: e }, "gmail draft update failed");
        const msg = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "I couldn't update that draft in Gmail right now. Try again in a moment.",
            status: "complete",
            parentMessageId: userMsg.id,
          },
        });
        res.status(200).json({
          message: { id: msg.id, conversationId, role: "assistant", content: msg.content, createdAt: msg.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      // The new draft exists — now remove the superseded one from Gmail so
      // repeated edits don't pile up orphaned copies. A
      // user-initiated cancel intentionally keeps its draft; only the draft
      // being edited away is removed here, and only once the replacement landed.
      await deleteEmailDraft(userId, pendingAction.draftId).catch((e) =>
        getLogger().warn({ err: e, conversationId, draftId: pendingAction.draftId }, "failed to delete superseded gmail draft on edit"),
      );
      const draftText = `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body}`;
      const msg = await prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: `Here's the updated draft I'll send:\n\n${draftText}\n\nReply **send** to send it, or **cancel** to keep it as a draft.`,
          status: "complete",
          parentMessageId: userMsg.id,
          toolCalls: {
            type: EMAIL_ACTION_TYPE,
            status: "pending",
            draftId: draft.draftId,
            draft: { to: d.to, subject: d.subject, body: d.body },
          },
        },
      });
      res.status(200).json({
        message: { id: msg.id, conversationId, role: "assistant", content: msg.content, createdAt: msg.createdAt },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      });
      return;
    } else if (resolved.intent === "ambiguous") {
      replyContent = "Should I send the draft or cancel it? Reply **send** to send it, or **cancel** to keep it as a draft.";
    } else {
      replyContent = `There's a pending email draft to ${pendingAction.draft.to} ("${pendingAction.draft.subject}"). Resolve it first — reply **send** to send it, or **cancel** to keep it as a draft.`;
    }
    const reply = await prisma.message.create({
      data: { conversationId, role: "assistant", content: replyContent, status: "complete", parentMessageId: userMsg.id },
    });
    res.status(200).json({
      message: {
        id: reply.id,
        conversationId,
        role: "assistant",
        content: reply.content,
        createdAt: reply.createdAt,
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
    });
    return;
  }

  // A pending agent draft forces resolution before any new work — the
  // execution agent's verbatim content sits in the thread awaiting confirm or
  // cancel. Confirm re-triggers the SAME agent with the draft as context; cancel
  // marks the draft dead and the agent is not re-run. An unrelated message
  // ("unrelated" intent) is NOT consumed here — the draft stays pending and the
  // user's actual message falls through to normal processing below.
  const pendingAgentDraft = await findPendingAgentDraft(conversationId);
  if (pendingAgentDraft) {
    const intent = await resolveAgentDraft(userId, content, pendingAgentDraft.actionLabel);
    if (intent !== "unrelated") {
      let replyContent: string;
      if (intent === "confirm") {
        await prisma.outboxEvent.create({
          data: {
            eventType: "draft_confirmed",
            payload: {
              agentId: pendingAgentDraft.agentId,
              trigger: "draft_confirmed",
              context: pendingAgentDraft.draft.content,
            },
          },
        });
        await markAgentDraft(pendingAgentDraft.messageId, "executed", { confirmedAt: new Date().toISOString() });
        await trackEvent(userId, "agent_draft_confirmed", {
          conversationId,
          agentId: pendingAgentDraft.agentId,
        });
        const ack = await writeAck({
          userId,
          conversationId,
          parentMessageId: userMsg.id,
          kind: "agent_draft_confirm",
          context: pendingAgentDraft.actionLabel ?? "act on the confirmed draft",
        });
        res.status(200).json(ack);
        return;
      } else if (intent === "cancel") {
        await markAgentDraft(pendingAgentDraft.messageId, "cancelled");
        await trackEvent(userId, "agent_draft_cancelled", {
          conversationId,
          agentId: pendingAgentDraft.agentId,
        });
        replyContent = "Cancelled — I'll leave that draft as-is.";
      } else {
        replyContent = "There's a pending draft waiting for your call. Reply **yes** to proceed, or **no** to cancel it.";
      }
      const reply = await prisma.message.create({
        data: { conversationId, role: "assistant", content: replyContent, status: "complete", parentMessageId: userMsg.id },
      });
      res.status(200).json({
        message: {
          id: reply.id,
          conversationId,
          role: "assistant",
          content: reply.content,
          createdAt: reply.createdAt,
        },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      });
      return;
    }
  }

  // Context: prior assistant/user turns so the reply is a conversation, not a one-shot.
  // Window is the most RECENT 50 (desc + take 50), returned oldest->newest.
  const history = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const messages = lastNMessages(history).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Email write/send requests run BEFORE the interaction-agent classification so
  // "send an email to X" is never captured by spawn_agent (execution agents stay
  // watch-only by design). A cheap keyword gate guards the extra structured LLM
  // call; non-send email mentions ("watch my email for ...") fall through to the
  // interaction agent below.
  if (emailActionHint(content)) {
    // Connection state is checked BEFORE the proposal call and fed to the LLM so
    // the model never promises to send while disconnected. The connect prompt is
    // only ever written after this real (Nango-reconciled) state check.
    const gmailConnected = await isGmailConnected(userId);
    const proposal = await proposeEmailAction(userId, [...messages, { role: "user", content }], gmailConnected ? "connected" : "not_connected");
    if (proposal.intent === "send_email") {
      // A real send needs Gmail — short-circuit to a connect prompt (with an
      // in-chat Connect button) before drafting.
      if (!gmailConnected) {
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "Connect Gmail first, then I can write and send email for you.",
            status: "complete",
            parentMessageId: userMsg.id,
            toolCalls: { type: "gmail.connect", status: "pending" },
          },
        });
        res.status(200).json({
          message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      if (!EMAIL_TO_RE.test(proposal.to) || !proposal.subject || !proposal.body) {
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "I need a recipient email address and the full message to draft that for you. Could you tell me who to send it to and what to say?",
            status: "complete",
            parentMessageId: userMsg.id,
          },
        });
        res.status(200).json({
          message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      if (proposal.subject.length > EMAIL_SUBJECT_MAX || proposal.body.length > EMAIL_BODY_MAX) {
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "That draft is too long to send. Could you shorten it and ask again?",
            status: "complete",
            parentMessageId: userMsg.id,
          },
        });
        res.status(200).json({
          message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      await cancelPendingEmailActions(conversationId);
      // Universal acknowledgment first: the user hears "preparing the draft"
      // (never "sending") before the Gmail draft is created.
      await writeAck({
        userId,
        conversationId,
        parentMessageId: userMsg.id,
        kind: "draft",
        context: `prepare a draft email to ${proposal.to} about "${proposal.subject}"`,
      });
      let draft: { draftId: string; messageId: string };
      try {
        draft = await createEmailDraft(userId, { to: proposal.to, subject: proposal.subject, body: proposal.body });
      } catch (e) {
        if (e instanceof ConnectionError) {
          getLogger().warn({ err: e }, "email draft blocked by expired gmail token");
          await markGmailExpired(userId);
          const reply = await prisma.message.create({
            data: {
              conversationId,
              role: "assistant",
              content: "Your Gmail connection expired. Reconnect Gmail, then ask me to draft that again.",
              status: "complete",
              parentMessageId: userMsg.id,
              toolCalls: { type: "gmail.connect", status: "pending" },
            },
          });
          res.status(200).json({
            message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            latencyMs: 0,
          });
          return;
        }
        getLogger().error({ err: e }, "gmail draft creation failed");
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "I couldn't create that draft in Gmail right now. Try again in a moment.",
            status: "complete",
            parentMessageId: userMsg.id,
          },
        });
        res.status(200).json({
          message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        });
        return;
      }
      const draftText = `To: ${proposal.to}\nSubject: ${proposal.subject}\n\n${proposal.body}`;
      await trackEvent(userId, "email_draft_proposed", {
        conversationId,
        draftId: draft.draftId,
        to: proposal.to,
        subject: proposal.subject,
      });
      const reply = await prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: `Here's the draft I'll send:\n\n${draftText}\n\nReply **send** to send it, or **cancel** to keep it as a draft.`,
          status: "complete",
          parentMessageId: userMsg.id,
          toolCalls: {
            type: EMAIL_ACTION_TYPE,
            status: "pending",
            draftId: draft.draftId,
            draft: { to: proposal.to, subject: proposal.subject, body: proposal.body },
          },
        },
      });
      res.status(200).json({
        message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      });
      return;
    }
  }

  // Interaction Agent classifies the intent. spawn_agent delegates to an
  // execution agent (dedup -> outbox); answer_directly falls through to the chat flow.
  // A cheap context-resolution stage (rewrite) folds recent turns into a
  // self-contained query FIRST so anaphora ("look it up", "that thing") and
  // corrections route correctly.
  const rewritten = await rewriteQuery(userId, messages, content);
  await trackEvent(userId, "query_rewritten", { conversationId, rewritten, reworded: rewritten !== content });
  const classification = await classifyMessage(userId, rewritten, await listActiveAgents(userId));

  // --- Management: cancel/forget/delete ---
  // A stop/cancel/forget/negation request archives the matching active Agent(s)
  // and disables their Triggers — it must NEVER become a retarget/resume. The
  // classifier guarantees no targetAgentId for manage_cancel.
  if (classification.action === "manage_cancel") {
    await trackEvent(userId, "agent_manage_cancel_classified", { conversationId, targetHint: classification.targetHint ?? null });
    const { archived } = await archiveAgents(userId, classification.targetHint);
    const replyContent =
      archived.length > 0
        ? "Done — I've stopped that."
        : "There's nothing matching that to stop right now.";
    const reply = await prisma.message.create({
      data: { conversationId, role: "assistant", content: replyContent, status: "complete", parentMessageId: userMsg.id },
    });
    res.status(200).json({
      message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
    });
    return;
  }

  // --- Management: list active watches/triggers ---
  if (classification.action === "manage_list") {
    await trackEvent(userId, "agent_manage_list_classified", { conversationId });
    const agents = await listActiveWithTriggers(userId);
    if (agents.length === 0) {
      const reply = await prisma.message.create({
        data: { conversationId, role: "assistant", content: "Nothing active right now.", status: "complete", parentMessageId: userMsg.id },
      });
      res.status(200).json({
        message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      });
      return;
    }
    const lines = agents.map((a, i) => {
      const trigs = a.triggers.map((t) => t.criteria).filter(Boolean);
      return `${i + 1}. ${a.taskDescription}${trigs.length ? ` — when: ${trigs.join("; ")}` : ""}`;
    });
    const replyContent = lines.join("\n");
    const reply = await prisma.message.create({
      data: { conversationId, role: "assistant", content: replyContent, status: "complete", parentMessageId: userMsg.id },
    });
    res.status(200).json({
      message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
    });
    return;
  }

  // --- Ambiguity guard: never create state from a vague request ---
  if (classification.action === "ask_clarification") {
    await trackEvent(userId, "agent_ask_clarification", { conversationId });
    const reply = await prisma.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: "Could you be a bit more specific about what you'd like me to do? I didn't want to set anything up until you confirm.",
        status: "complete",
        parentMessageId: userMsg.id,
      },
    });
    res.status(200).json({
      message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
    });
    return;
  }

  // --- One-time tool-backed answer (no Agent row) ---
  // A single-turn live lookup ("use the browser to check the gold price") is
  // delegated to the agent-once queue — the worker answers with the tools and
  // creates NO Agent. The rewritten query (anaphora resolved) is what runs.
  if (classification.action === "one_shot") {
    await trackEvent(userId, "agent_one_shot_classified", { conversationId, confidence: classification.confidence, complexity: classification.complexity });
    await prisma.outboxEvent.create({
      data: {
        eventType: "one_shot",
        payload: { userId, conversationId, content: rewritten, complexity: classification.complexity },
      },
    });
    getLogger().info({ conversationId }, "one-shot query delegated via outbox");
    const ack = await writeAck({
      userId,
      conversationId,
      parentMessageId: userMsg.id,
      kind: "one_shot",
      context: rewritten,
    });
    res.status(200).json(ack);
    return;
  }

  if (classification.action === "spawn_agent" && classification.taskDescription) {
    await trackEvent(userId, "agent_spawn_classified", {
      conversationId,
      confidence: classification.confidence,
      targetAgentId: classification.targetAgentId ?? null,
    });

    // targetAgentId means "reuse this existing agent" — trigger it,
    // never spawn a duplicate next to it.
    if (classification.targetAgentId) {
      const target = await prisma.agent.findFirst({
        where: { id: classification.targetAgentId, userId, status: "active" },
      });
      if (target) {
        await prisma.outboxEvent.create({
          data: {
            eventType: "retarget_agent",
            payload: { agentId: target.id, trigger: "user_message", context: content },
          },
        });
        getLogger().info({ agentId: target.id, conversationId }, "existing agent retargeted via outbox");
        const ack = await writeAck({
          userId,
          conversationId,
          parentMessageId: userMsg.id,
          kind: "retarget",
          context: `resume the existing watch: ${target.taskDescription}`,
        });
        res.status(200).json(ack);
        return;
      }
    }

    const { duplicate, embedding: dedupEmbedding } = await findDuplicateAgent(userId, classification.taskDescription);
    if (duplicate) {
      // A functional dedup question, not a work ack — kept fixed so the choice is
      // unambiguous.
      const reply = await prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: `It looks like I'm already watching something very similar: "${duplicate.taskDescription}". Want me to keep doing that, or start fresh?`,
          status: "complete",
          parentMessageId: userMsg.id,
        },
      });
      getLogger().info({ conversationId, duplicate: true }, "agent spawn acknowledged (duplicate)");
      res.status(200).json({
        message: {
          id: reply.id,
          conversationId,
          role: "assistant",
          content: reply.content,
          createdAt: reply.createdAt,
        },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        possibleDuplicateOf: duplicate.id,
      });
      return;
    }

    // dedupEmbedding is set when findDuplicateAgent's embed succeeded; only
    // re-embed on the rare failure path (dedup degrades to no-match).
    let embedding = dedupEmbedding;
    if (!embedding) {
      try {
        embedding = await embedTask(classification.taskDescription);
      } catch (e) {
        getLogger().error({ err: e }, "embedding failed; refusing to spawn agent");
        const mapped = mapLLMError(e);
        res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
        return;
      }
    }
    const { agentId } = await spawnAgent({
      userId,
      ownerConversationId: conversationId,
      taskDescription: classification.taskDescription,
      embedding,
      context: content,
      complexity: classification.complexity,
    });
    await trackEvent(userId, "agent_spawned", { conversationId, agentId });
    // Cheap-model trigger extraction: an implicit "watch-for" condition
    // gets its own Trigger row so the 1-min tick can fire the agent.
    const triggerProposal = await classifyTrigger(userId, content, classification.taskDescription);
    if (triggerProposal.hasTrigger && triggerProposal.criteria) {
      await prisma.trigger.create({
        data: {
          agentId,
          name: triggerProposal.name ?? "trigger",
          criteria: triggerProposal.criteria,
        },
      });
      await trackEvent(userId, "agent_trigger_created", { conversationId, agentId });
    }
    getLogger().info({ agentId, conversationId }, "agent spawned via outbox");
    const ack = await writeAck({
      userId,
      conversationId,
      parentMessageId: userMsg.id,
      kind: "spawn",
      context: `start watching: ${classification.taskDescription}`,
    });
    getLogger().info({ conversationId, duplicate: false }, "agent spawn acknowledged");
    res.status(200).json(ack);
    return;
  }

  let result;
  try {
    // The Interaction Agent persona (system.md + rules.md + integrations.md +
    // email.md + meomery.md) leads the chat context — everything the model says
    // to the user is governed by it.
    // Once the thread reaches the window (history.length === 50 means
    // the query was capped, i.e. >=50 messages), retrieve durable facts for the
    // current message and inject them as a system block after the persona.
    const factBlock = shouldFetchFacts(history.length)
      ? factContextBlock(await searchActiveFacts(conversationId, content))
      : null;
    const replyContext = factBlock
      ? [{ role: "system" as const, content: factBlock }, ...messages]
      : messages;
    result = await callOpenRouter([{ role: "system", content: chatSystemPrompt() }, ...replyContext], { useCase: "chat_response" });
  } catch (e) {
    getLogger().error({ err: e }, "openrouter call failed");
    await prisma.message.update({
      where: { id: userMsg.id },
      data: { status: "failed", errorDetail: { message: mapLLMError(e).message } },
    });
    const mapped = mapLLMError(e);
    await trackModelCall({ userId, useCase: "chat_response", error: mapped.message });
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }
  const logId = await trackModelCall({ userId, useCase: "chat_response", result });
  if (result.generationId && logId) backfillCost(result.generationId, logId);
  await rollDailyUsage(userId, result.usage.totalTokens);

  // Record input tokens on the user message, and full usage + latency on the reply.
  await prisma.message.update({
    where: { id: userMsg.id },
    data: { promptTokens: result.usage.promptTokens },
  });

  const reply = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: result.content,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.latencyMs,
      parentMessageId: userMsg.id,
    },
  });

  getLogger().info(
    { conversationId, tokens: result.usage.totalTokens, latencyMs: result.latencyMs },
    "assistant reply written",
  );
  await trackEvent(userId, "chat_message_reply", {
    conversationId,
    model: result.model,
    totalTokens: result.usage.totalTokens,
    latencyMs: result.latencyMs,
  });
  res.status(200).json({
    message: {
      id: reply.id,
      conversationId,
      role: "assistant",
      content: reply.content,
      createdAt: reply.createdAt,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
      totalTokens: reply.tokenCount,
      durationMs: reply.durationMs,
    },
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    },
    latencyMs: result.latencyMs,
  });
});

// GET /api/v1/conversation — single persistent thread (find-or-create).
messageRouter.get("/conversation", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  let conversation = await prisma.conversation.findFirst({ where: { userId } });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { userId } });
  }
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });
  getLogger().info({ conversationId: conversation.id, messageCount: messages.length }, "conversation loaded");
  res.json({
    conversation: { id: conversation.id, messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.tokenCount,
      durationMs: m.durationMs,
      toolCalls: m.toolCalls ?? null,
    })) },
  });
});

export { messageRouter };