import { getConfig, getLogger } from "@mimir/backend-core";
import { emitToUser } from "./socket.js";
import { sendPushToSubscriptions } from "../routes/push.js";

export type DeliveryChannel = "socket" | "push" | "none";

// 7.4 — the single delivery decision point. Called from the api's pub/sub
// pmessage handler for every user event. Order: live socket → web push. If
// neither reaches the user, "none" — the message stays in the thread and shows
// on next open. No email: email is a watched source (Mimir's job is to surface
// its contents in-app), not a delivery channel.
export async function deliverToUser(
  userId: string,
  eventName: string,
  payload: { [k: string]: unknown },
): Promise<DeliveryChannel> {
  const delivered = emitToUser(userId, eventName, payload);
  if (delivered > 0) return "socket";

  const cfg = getConfig();
  const body = typeof payload.content === "string" ? String(payload.content) : eventName;
  const pushed = await sendPushToSubscriptions(userId, cfg, { title: "Mimir", body });
  if (pushed > 0) return "push";

  getLogger().info({ userId, eventName }, "no delivery channel; message persisted in thread");
  return "none";
}
