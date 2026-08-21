import type { Server as HttpServer } from "node:http";
import { getConfig, getLogger } from "@mimir/backend-core";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import { parseCookies, verifyAccessToken } from "../auth/tokens.js";
import { deliverToUser } from "./delivery.js";

const cfg = getConfig();
const socketsByUser = new Map<string, Set<string>>();

let io: Server | null = null;

// Attaches socket.io to the same http server express uses, authenticating each
// handshake with the access_token cookie and tracking the user's live sockets so
// pub/sub can push to them.
export function initSocket(server: HttpServer): void {
  const origins = [cfg.WEB_APP_URL, "http://localhost:3000", "tauri://localhost"].filter(
    (o): o is string => Boolean(o),
  );
  io = new Server(server, { cors: { origin: origins, credentials: true } });

  io.use(async (socket, next) => {
    const token = parseCookies(socket.handshake.headers.cookie).access_token;
    const userId = token ? await verifyAccessToken(token, cfg.JWT_SECRET) : null;
    if (!userId) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    let ids = socketsByUser.get(userId);
    if (!ids) socketsByUser.set(userId, (ids = new Set()));
    ids.add(socket.id);
    getLogger().info({ userId, socketId: socket.id, open: ids.size }, "socket connected");
    // Manual ping/pong test event (distinct from socket.io's wire-level ping).
    socket.on("ping", (cb) => {
      if (typeof cb === "function") cb({ event: "pong", at: new Date().toISOString() });
      else socket.emit("pong", { at: new Date().toISOString() });
    });
    socket.on("disconnect", () => {
      ids.delete(socket.id);
      if (ids.size === 0 && socketsByUser.get(userId) === ids) socketsByUser.delete(userId);
      getLogger().info({ userId, socketId: socket.id, open: ids.size }, "socket disconnected");
    });
  });
}

// Look up a user's live sockets and emit to all of them.
export function emitToUser(userId: string, event: string, payload: unknown): number {
  const ids = socketsByUser.get(userId);
  if (!io || !ids || ids.size === 0) return 0;
  for (const socketId of ids) io.to(socketId).emit(event, payload);
  return ids.size;
}

// Worker publishes on `user-events:{userId}`; subscribe here and push to the
// user's sockets. Pattern subscribe needs its own connection — a subscribed
// ioredis client can't run normal commands.
let pubsubStarted = false;
export function initPubSub(subscriber: Redis): void {
  if (pubsubStarted) return;
  pubsubStarted = true;
  subscriber.psubscribe("user-events:*");
  subscriber.on("error", (e) => getLogger().error({ err: e }, "pub/sub redis error"));
  subscriber.on("pmessage", (_pattern, chan, message) => {
    const userId = chan.replace(/^user-events:/, "");
    let parsed: { event?: string; payload?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      getLogger().warn({ channel: chan, message }, "dropping non-JSON pub/sub payload");
      return;
    }
    // Payloads carry their own event name ({event:'new_message',...}); emit on
    // that name so the web client can wire per-event handlers. Falls back to "debug".
    const eventName = typeof parsed.event === "string" ? parsed.event : "debug";
    // Live socket → web push. No email: email is a watched source, not a delivery channel.
    void deliverToUser(userId, eventName, (parsed.payload ?? {}) as { [k: string]: unknown })
      .then((delivery) => getLogger().info({ userId, eventName, channel: delivery }, "user event delivered"))
      .catch((e) => getLogger().error({ err: e, userId }, "delivery decision failed"));
  });
}
