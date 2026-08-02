import { getConfig, getLogger, getPrismaClient, runWithContext, tracer } from "@mimir/backend-core";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import passport from "passport";
import { setupExpressErrorHandler } from "@sentry/node";
import { authRouter } from "./auth.js";
import { redis } from "./redis.js";

const config = getConfig();
const app = express();
const prisma = getPrismaClient();

app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
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
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  res.on("close", () => span.end());
  runWithContext({ requestId }, () => context.with(trace.setSpan(context.active(), span), next));
});

app.use(express.json());
app.use(passport.initialize());
app.use("/api/v1/auth", authRouter);

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

createServer(app).listen(config.PORT, () => {
  getLogger().info({ port: config.PORT }, "@mimir/api listening");
});
