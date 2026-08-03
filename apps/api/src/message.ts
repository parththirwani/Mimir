import {
  getLogger,
  getPrismaClient,
  callOpenRouter,
  trackEvent,
  trackModelCall,
  backfillCost,
  rollDailyUsage,
} from "@mimir/backend-core";
import { messageSchema } from "@mimir/zod-schemas";
import { Router } from "express";
import { requireAuth } from "./auth.js";
import { mapLLMError } from "./errors.js";
import {
  classifyMessage,
  embedTask,
  findDuplicateAgent,
  listActiveAgents,
  spawnAgent,
} from "./agent.js";

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

  // Phase 4: Interaction Agent classifies the intent. spawn_agent delegates to an
  // execution agent (dedup -> outbox); answer_directly falls through to the chat flow.
  const classification = await classifyMessage(userId, content, await listActiveAgents(userId));
  if (classification.action === "spawn_agent" && classification.taskDescription) {
    await trackEvent(userId, "agent_spawn_classified", {
      conversationId,
      confidence: classification.confidence,
      targetAgentId: classification.targetAgentId ?? null,
    });

    // Plan 4.2.1: targetAgentId means "reuse this existing agent" — trigger it,
    // never spawn a duplicate next to it.
    if (classification.targetAgentId) {
      const target = await prisma.agent.findFirst({
        where: { id: classification.targetAgentId, userId, status: "active" },
      });
      if (target) {
        await prisma.outboxEvent.create({
          data: {
            eventType: "retarget_agent",
            payload: { agentId: target.id, trigger: "user_message" },
          },
        });
        getLogger().info({ agentId: target.id, conversationId }, "existing agent retargeted via outbox");
        const reply = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: `I'll use your existing agent for: "${target.taskDescription}". I'll surface anything relevant here.`,
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
      ack = `It looks like you already have an agent watching something very similar: "${duplicate.taskDescription}". Want me to reuse that one, or set up a new one?`;
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
      });
      await trackEvent(userId, "agent_spawned", { conversationId, agentId });
      getLogger().info({ agentId, conversationId }, "agent spawned via outbox");
      ack = `Done — I've set up an agent to: "${classification.taskDescription}". I'll surface anything relevant here.`;
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

  // Context: prior assistant/user turns so the reply is a conversation, not a one-shot.
  const history = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const messages = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "chat_response" });
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
    })) },
  });
});

export { messageRouter };