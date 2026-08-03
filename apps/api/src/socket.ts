import type { Server as HttpServer } from "node:http";
import { getConfig, getLogger } from "@mimir/backend-core";
import { Server } from "socket.io";
import { parseCookies, verifyAccessToken } from "./tokens.js";

const cfg = getConfig();

// ponytail: single-instance in-memory socket registry. Phase 10.1 replaces this
// with Redis (SADD user-sockets:{userId} + TTL heartbeat) and the socket.io Redis
// adapter; don't harden this map for multi-instance.
const socketsByUser = new Map<string, Set<string>>();

let io: Server | null = null;

// Attaches socket.io to the http server created in 0.3 (the same one express uses),
// authenticating each handshake with the access_token cookie and tracking the
// user's live sockets so Phase 3.3's pub/sub can push to them.
export function initSocket(server: HttpServer): void {
  const origins = [cfg.WEB_APP_URL, "http://localhost:3000"].filter((o): o is string => Boolean(o));
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
    socket.on("disconnect", () => {
      ids.delete(socket.id);
      // Guard against a stale closure deleting a newer live set (edge: socket A
      // disconnects after A reconnected as B — the map now holds B's set).
      if (ids.size === 0 && socketsByUser.get(userId) === ids) socketsByUser.delete(userId);
      getLogger().info({ userId, socketId: socket.id, open: ids.size }, "socket disconnected");
    });
  });
}

// Phase 3.3's consumer: look up a user's live sockets and emit to all of them.
export function emitToUser(userId: string, event: string, payload: unknown): number {
  const ids = socketsByUser.get(userId);
  if (!io || !ids || ids.size === 0) return 0;
  for (const socketId of ids) io.to(socketId).emit(event, payload);
  return ids.size;
}
