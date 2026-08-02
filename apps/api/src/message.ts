import {
  getLogger,
  getPrismaClient,
  callOpenRouter,
} from "@mimir/backend-core";
import { messageSchema } from "@mimir/zod-schemas";
import { Router } from "express";
import { requireAuth } from "./auth.js";
import { mapLLMError } from "./errors.js";

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

  // A completed retry returns the stored result without a second LLM call.
  if (isRetry) {
    const reply = await prisma.message.findFirst({
      where: { parentMessageId: userMsg.id },
      orderBy: { createdAt: "asc" },
    });
    if (reply && reply.status === "complete") {
      res.status(200).json({
        message: { id: reply.id, conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: reply.tokenCount ?? 0 },
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
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  const reply = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: result.content,
      status: "complete",
      model: result.model,
      tokenCount: result.usage.totalTokens,
      parentMessageId: userMsg.id,
    },
  });

  getLogger().info({ conversationId, tokens: result.usage.totalTokens }, "assistant reply written");
  res.status(200).json({
    message: { id: reply.id, conversationId: conversationId, role: "assistant", content: reply.content, createdAt: reply.createdAt },
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    },
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
  res.json({
    conversation: { id: conversation.id, messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })) },
  });
});

export { messageRouter };