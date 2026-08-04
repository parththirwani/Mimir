import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { Redis } from "ioredis";

// Config is validated at import time — set env before any backend-core module loads.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "e2e-phase4-secret";
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY required for the real-LLM E2E test");
}

const { getPrismaClient } = await import("@mimir/backend-core");
const { authRouter } = await import("./auth.js");
const { messageRouter } = await import("./message.js");
const { agentJobs, startWorkers } = await import("../../worker/src/queues.js");

const prisma = getPrismaClient();
const PASSWORD = "password123";
const TASK = "Set up an agent to continuously watch my email for messages from Alice and tell me what she sends.";

async function poll<T>(fn: () => Promise<T>, ok: (t: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await Bun.sleep(100);
  }
}

describe("agent end-to-end (real LLM, mocked integration)", () => {
  // HTTP only — no initSocket/initPubSub. bun runs every test file in ONE process,
  // so those module-level singletons are owned by socket.test.ts / pubsub.test.ts.
  const app = express();
  app.use(express.json());
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1", messageRouter);
  const server = createServer(app);
  const workers = startWorkers();

  let port = 0;
  let accessToken = "";
  let userId = "";
  let conversationId = "";
  let deliverySub: Redis;
  const received: Array<{ messageId: string; conversationId: string }> = [];
  const agentIds: string[] = [];

  beforeAll(async () => {
    port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as { port: number }).port));
    });

    // 1. Auth — register a throwaway user, capture the access_token cookie.
    const email = `e2e-${Date.now()}-${randomUUID()}@test.local`;
    const reg = await fetch(`http://localhost:${port}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(reg.status).toBe(201);
    userId = (await reg.json()).user.id;
    const setCookies = reg.headers.getSetCookie() ?? [];
    const cookie = setCookies.find((c) => c.startsWith("access_token="));
    if (!cookie) throw new Error("register response missing access_token cookie");
    const accessTokenPart = cookie.split(";").find((p) => p.startsWith("access_token="));
    if (!accessTokenPart) throw new Error("register response missing access_token cookie");
    accessToken = accessTokenPart.slice("access_token=".length);

    // 2. Conversation — real find-or-create route.
    const conv = await fetch(`http://localhost:${port}/api/v1/conversation`, {
      headers: { Cookie: `access_token=${accessToken}` },
    });
    expect(conv.status).toBe(200);
    conversationId = (await conv.json()).conversation.id;
    expect(conversationId).toBeTruthy();

    // 3. Delivery — the worker publishes on user-events:{userId}; subscribe with a
    // dedicated connection (a subscribed ioredis client can't run other commands).
    deliverySub = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    await deliverySub.subscribe(`user-events:${userId}`);
    deliverySub.on("message", (_channel, message) => {
      let parsed: { event?: string; payload?: { messageId: string; conversationId: string } };
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (parsed.event === "new_message" && parsed.payload) received.push(parsed.payload);
    });
  });

  afterAll(async () => {
    // Close only OUR workers. agentJobs is a module singleton shared with
    // queues.test.ts (all test files run in one bun process) — never close it.
    await Promise.all(workers.map((w) => w.close()));
    await deliverySub?.quit();
    server.close();
    await prisma.agentEvent.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    for (const agentId of agentIds) {
      await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["agentId"], equals: agentId } } });
    }
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.usageRecord.deleteMany({ where: { userId } });
    await prisma.modelCallLog.deleteMany({ where: { userId } });
    await prisma.analyticsEvent.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  test(
    "classification -> spawn -> outbox -> execution -> delivery -> dedup",
    async () => {
      // 4. Spawn — POST /message triggers classification -> dedup -> spawn tx.
      const msg = await fetch(`http://localhost:${port}/api/v1/message`, {
        method: "POST",
        headers: { Cookie: `access_token=${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content: TASK, clientMessageId: randomUUID() }),
      });
      expect(msg.status).toBe(200);
      const body = (await msg.json()) as { possibleDuplicateOf?: string };
      expect(body.possibleDuplicateOf).toBeUndefined();

      // 5. Spawn tx wrote the Agent + OutboxEvent rows together.
      const agent = await poll(
        () => prisma.agent.findFirst({ where: { userId } }),
        (a) => !!a,
      );
      agentIds.push(agent!.id);
      const outbox = await poll(
        () =>
          prisma.outboxEvent.findFirst({
            where: { payload: { path: ["agentId"], equals: agent!.id } },
          }),
        (row) => !!row,
      );
      expect(outbox!.processedAt).toBeNull();

      // Relay — replicate drainOutbox's per-row behavior scoped to OUR row. Running
      // drainOutbox() here would also drain outbox-relay.test.ts's rows (shared table,
      // one process), so don't. The relay itself is covered by outbox-relay.test.ts.
      await agentJobs.add(
        "execute",
        { agentId: agent!.id, trigger: "user_message" },
        { jobId: `outbox-${outbox!.id}` },
      );
      await prisma.outboxEvent.update({ where: { id: outbox!.id }, data: { processedAt: new Date() } });

      // 6. Execution — AgentEvent written (surfaced OR discarded, never skipped).
      const event = await poll(
        () => prisma.agentEvent.findFirst({ where: { agentId: agent!.id } }),
        (e) => !!e,
      );
      expect(["surfaced", "discarded"]).toContain(event!.eventType);

      // 7. Delivery — only surfaced events reach the conversation + the pub/sub channel.
      if (event!.eventType === "surfaced") {
        const surfaced = await poll(
          async () => {
            const msgs = await prisma.message.findMany({
              where: { conversationId, role: "assistant" },
              orderBy: { createdAt: "asc" },
            });
            return msgs.length >= 2 ? msgs[msgs.length - 1] : null;
          },
          (m) => !!m,
        );
        expect(surfaced!.id).toBeTruthy();
        await poll(() => Promise.resolve(received), (r) => r.some((m) => m.messageId === surfaced!.id));
        expect(received.some((m) => m.messageId === surfaced!.id)).toBe(true);
        expect(received.some((m) => m.conversationId === conversationId)).toBe(true);
      }

      // 8. Dedup — the same task again must NOT spawn a second agent.
      const dup = await fetch(`http://localhost:${port}/api/v1/message`, {
        method: "POST",
        headers: { Cookie: `access_token=${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content: TASK, clientMessageId: randomUUID() }),
      });
      expect(dup.status).toBe(200);
      const dupBody = (await dup.json()) as { possibleDuplicateOf?: string };
      expect([undefined, agent!.id]).toContain(dupBody.possibleDuplicateOf);
      await poll(
        async () => {
          const count = await prisma.agent.count({ where: { userId } });
          return count === 1 ? count : null;
        },
        (c) => c === 1,
      );
      expect(await prisma.agent.count({ where: { userId } })).toBe(1);
    },
    180_000,
  );
});
