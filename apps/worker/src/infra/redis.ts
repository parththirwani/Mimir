import { getConfig, getLogger } from "@mimir/backend-core";
import { Redis } from "ioredis";

const cfg = getConfig();

// Publisher for user-events: the worker writes to Postgres first, then publishes
// here so the api's pub/sub subscriber delivers via socket.
export const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on("error", (e) => getLogger().error({ err: e }, "worker redis error"));

export async function publishUserEvent(userId: string, event: string, payload: unknown): Promise<void> {
  await redis.publish(`user-events:${userId}`, JSON.stringify({ event, payload, at: new Date().toISOString() }));
}

// Notification-body budget (11.4): OS and web push render one line; longer or
// newline-rich text gets clipped or collapses awkwardly. Centralized here so
// every publish site gets a short, safe body without each remembering to.
const NOTIFICATION_CONTENT_MAX = 160;

// Build the payload for a surfaced new_message that carries a human-readable
// `content` snippet (the delivery fallback's push body). Content is truncated to
// NOTIFICATION_CONTENT_MAX and newlines collapsed; falsy content is omitted so
// deliverToUser falls back to the event name instead of an empty body.
export function newMessagePayload(
  conversationId: string,
  message: { id: string; content?: string | null },
): { conversationId: string; messageId: string; content?: string } {
  const content = message.content?.replace(/\s+/g, " ").trim();
  if (!content) return { conversationId, messageId: message.id };
  return {
    conversationId,
    messageId: message.id,
    content: content.length <= NOTIFICATION_CONTENT_MAX ? content : `${content.slice(0, NOTIFICATION_CONTENT_MAX - 1)}…`,
  };
}
