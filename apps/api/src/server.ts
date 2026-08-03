import { getConfig, getLogger, getPrismaClient, runWithContext, tracer } from "@mimir/backend-core";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import passport from "passport";
import { setupExpressErrorHandler } from "@sentry/node";
import { authRouter, requireAuth } from "./auth.js";
import { messageRouter } from "./message.js";
import { redis } from "./redis.js";
import { emitToUser, initSocket } from "./socket.js";

const config = getConfig();
const app = express();
const prisma = getPrismaClient();

app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = performance.now();
  res.setHeader("x-request-id", requestId);
  const span = tracer.startSpan(`http ${req.method} ${req.path}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": req.method,
      "url.path": req.path,
      "requestId": requestId,
    },
  });
  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - startedAt);
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    getLogger().info({ method: req.method, path: req.path, status: res.statusCode, durationMs }, "request");
  });
  res.on("close", () => span.end());
  runWithContext({ requestId }, () => context.with(trace.setSpan(context.active(), span), next));
});

app.use(express.json());

// CORS for the static-export web app (different origin/port). Reflect only
// known origins; always allow credentials (cookie-based auth).
const allowedOrigins = new Set([config.WEB_APP_URL, "http://localhost:3000"].filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(passport.initialize());
app.use("/api/v1/auth", authRouter);
app.use("/api/v1", messageRouter);

// ponytail: throwaway Phase 2 checkpoint route — lets a logged-in user's open tabs
// receive a manual server-side emit. Delete when Phase 3.3 wires real pub/sub events.
app.post("/api/v1/debug/emit", requireAuth, (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const sent = emitToUser(userId, "debug", { payload: req.body, at: new Date().toISOString() });
  res.json({ sent });
});

app.get("/health", async (_req, res) => {
  let db = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "error";
  }
  let cache = "ok";
  try {
    if ((await redis.ping()) !== "PONG") cache = "error";
  } catch {
    cache = "error";
  }
  const ok = db === "ok" && cache === "ok";
  getLogger().info({ checks: { db, redis: cache } }, "health check");
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks: { db, redis: cache } });
});

setupExpressErrorHandler(app);

const server = createServer(app);
initSocket(server);
server.listen(config.PORT, () => {
  getLogger().info({ port: config.PORT }, "@mimir/api listening");
});
