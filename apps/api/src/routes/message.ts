import {
  getLogger,
  getPrismaClient,
  callOpenRouter,
  trackEvent,
  trackModelCall,
  backfillCost,
  rollDailyUsage,
  chatSystemPrompt,
} from "@mimir/backend-core";
import { messageSchema } from "@mimir/zod-schemas";
import { ConnectionError } from "@mimir/connection-provider";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";
import { mapLLMError } from "../infra/errors.js";
import { GMAIL_INTEGRATION } from "@mimir/connection-provider";
import {
  EMAIL_ACTION_TYPE,
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  EMAIL_TO_RE,
  cancelPendingEmailActions,
  createEmailDraft,
  emailActionHint,
  findPendingEmailAction,
  markEmailAction,
  markGmailExpired,
  proposeEmailAction,
  resolvePendingAction,
  sendPendingEmail,
} from "../email/email-action.js";
import {
  classifyMessage,
  classifyTrigger,
  embedTask,
  findDuplicateAgent,
  listActiveAgents,
  spawnAgent,
} from "../agent/agent.js";
import {
  findPendingAgentDraft,
  markAgentDraft,
  resolveAgentDraft,
} from "../agent/agent-draft.js";

const prisma = getPrismaClient();

const messageRouter: Router = Router();

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
    const intent = await resolvePendingAction(userId, content, pendingAction.draft);
    let replyContent: string;
    if (intent === "confirm") {
      try {
        const sentId = await sendPendingEmail(userId, pendingAction.draftId);
        await markEmailAction(pendingAction.messageId, "executed", { sentMessageId: sentId });
        await trackEvent(userId, "email_sent", {
          conversationId,
          draftId: pendingAction.draftId,
          to: pendingAction.draft.to,
          subject: pendingAction.draft.subject,
        });
        replyContent = `Sent to ${pendingAction.draft.to}: "${pendingAction.draft.subject}".`;
      } catch (e) {
        if (e instanceof ConnectionError) {
          getLogger().warn({ err: e }, "email send blocked by expired gmail token");
          await markGmailExpired(userId);
          replyContent = "Your Gmail connection expired. Reconnect Gmail, then tell me to send the draft again.";
        } else {
          getLogger().error({ err: e }, "email send failed; draft kept pending");
          replyContent = "The email couldn't be sent right now. It's still in your Gmail drafts — try again in a moment.";
        }
      }
    } else if (intent === "cancel") {
      await markEmailAction(pendingAction.messageId, "cancelled");
      await trackEvent(userId, "email_cancelled", {
        conversationId,
        draftId: pendingAction.draftId,
        to: pendingAction.draft.to,
        subject: pendingAction.draft.subject,
      });
      replyContent = "Cancelled — the email stays in your Gmail drafts if you want to edit it there.";
    } else if (intent === "ambiguous") {
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

  // A pending agent draft (4.10) forces resolution before any new work — the
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
        replyContent = pendingAgentDraft.actionLabel
          ? `Got it — I'll ${pendingAgentDraft.actionLabel.toLowerCase()}.`
          : "Got it — I'll act on that draft.";
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
  const history = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const messages = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Email write/send requests run BEFORE the interaction-agent classification so
  // "send an email to X" is never captured by spawn_agent (execution agents stay
  // watch-only by design). A cheap keyword gate guards the extra structured LLM
  // call; non-send email mentions ("watch my email for ...") fall through to the
  // interaction agent below.
  if (emailActionHint(content)) {
    const proposal = await proposeEmailAction(userId, [...messages, { role: "user", content }]);
    if (proposal.intent === "send_email") {
      // A real send needs Gmail — short-circuit to a connect prompt before drafting.
      const gmailConnected = await prisma.integrationConnection.findFirst({ where: { userId, provider: GMAIL_INTEGRATION } });
      if (!gmailConnected) {
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: "Connect Gmail first, then I can write and send email for you.",
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
  const classification = await classifyMessage(userId, content, await listActiveAgents(userId));
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
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: `Got it — I'm already on that. I'll surface anything relevant here.`,
            status: "complete",
            parentMessageId: userMsg.id,
          },
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

    const { duplicate, embedding: dedupEmbedding } = await findDuplicateAgent(userId, classification.taskDescription);
    let ack: string;
    if (duplicate) {
      ack = `It looks like I'm already watching something very similar: "${duplicate.taskDescription}". Want me to keep doing that, or start fresh?`;
    } else {
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
      });
      await trackEvent(userId, "agent_spawned", { conversationId, agentId });
      // Cheap-model trigger extraction (4.11): an implicit "watch-for" condition
      // gets its own Trigger row so the 1-min tick can fire the agent. A misfire
      // here is harmless — no trigger just means the agent runs on user asks only.
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
      ack = `Done — I'll take care of that. I'll surface anything relevant here.`;
    }
    const reply = await prisma.message.create({
      data: { conversationId, role: "assistant", content: ack, status: "complete", parentMessageId: userMsg.id },
    });
    getLogger().info({ conversationId, duplicate: Boolean(duplicate) }, "agent spawn acknowledged");
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
      possibleDuplicateOf: duplicate?.id,
    });
    return;
  }

  let result;
  try {
    // The Interaction Agent persona (system.md + rules.md + integrations.md +
    // email.md + meomery.md) leads the chat context — everything the model says
    // to the user is governed by it.
    result = await callOpenRouter([{ role: "system", content: chatSystemPrompt() }, ...messages], { useCase: "chat_response" });
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