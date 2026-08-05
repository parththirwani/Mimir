import { generateAck, getLogger, getPrismaClient } from "@mimir/backend-core";
import type { AckKind, GenerateAckOptions } from "@mimir/backend-core";
import { redis } from "../infra/redis.js";

const prisma = getPrismaClient();

// The universal acknowledgment reply: a varied LLM-written line ("on it",
// "preparing your draft", "sending now") that lands in the thread instantly so
// the user knows work is in progress, with an instant fallback if the LLM call
// fails. Used at every delegation point so no action is ever acknowledged
// differently. Returns the standard {message, usage, latencyMs} response shape.
export async function writeAck(opts: {
  userId: string;
  conversationId: string;
  parentMessageId: string;
  kind: AckKind;
  context?: string;
  fallback?: string;
}): Promise<{
  message: { id: string; conversationId: string; role: string; content: string; createdAt: Date };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}> {
  const ackOpts: GenerateAckOptions = {
    context: opts.context,
    fallback: opts.fallback,
    userId: opts.userId,
  };
  const content = await generateAck(opts.kind, ackOpts);
  const reply = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      role: "assistant",
      content,
      status: "complete",
      parentMessageId: opts.parentMessageId,
    },
  });
  // The ack must reach the thread in real-time (not after the HTTP response), so
  // push a new_message event the instant the row commits — server.ts's
  // initPubSub forwards it to the user's socket. Best-effort: a publish failure
  // must never flip a successful ack.
  try {
    await redis.publish(
      `user-events:${opts.userId}`,
      JSON.stringify({ event: "new_message", payload: { conversationId: opts.conversationId, messageId: reply.id } }),
    );
  } catch (e) {
    getLogger().warn({ err: e, messageId: reply.id }, "ack publish failed (ack already written)");
  }
  return {
    message: {
      id: reply.id,
      conversationId: reply.conversationId,
      role: "assistant",
      content: reply.content,
      createdAt: reply.createdAt,
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    latencyMs: 0,
  };
}
