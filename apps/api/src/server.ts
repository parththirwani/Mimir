import { createServer } from "node:http";
import express from "express";
import { Redis } from "ioredis";
import { getConfig, getPrismaClient } from "@mimir/backend-core";

const config = getConfig();
const app = express();
const prisma = getPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
let redisErrorLogged = false;
redis.on("error", (e) => {
  if (!redisErrorLogged) {
    redisErrorLogged = true;
    console.error(`[redis] connection error: ${e.message}`);
  }
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
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks: { db, redis: cache } });
});

createServer(app).listen(config.PORT, () => {
  console.log(`@mimir/api listening on :${config.PORT}`);
});
