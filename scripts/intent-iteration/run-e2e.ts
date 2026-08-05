import { randomUUID } from "node:crypto";
import { mock } from "bun:test";
import { createServer } from "node:http";
import express from "express";

import { loadEnv } from "./_env.js";
import { corpus } from "./corpus.js";
import {
  e2ePassed,
  finalizeReport,
  renderReport,
  writeReport,
  MIMIR_STATUS_PATTERNS,
  type E2eResult,
} from "./lib.js";

loadEnv();

// Fake Nango — no external OAuth in this environment.
mock.module("@nangohq/node", () => {
  const Nango = class {
    async createConnectSession() {
      return { data: { connect_link: "https://connect.nango.dev/abc", token: "t", expires_at: "x" } };
    }
    async listConnections() {
      return { connections: [] };
    }
    async getConnection() {
      return { credentials: { type: "OAUTH2", access_token: "fake-token", raw: {} } };
    }
    async deleteConnection() {
      return {};
    }
  };
  return { Nango };
});

const { getPrismaClient } = await import("@mimir/backend-core");
const { authRouter } = await import("../../apps/api/src/auth/auth.js");
const { messageRouter } = await import("../../apps/api/src/routes/message.js");
const { startWorkers } = await import("../../apps/worker/src/infra/queues.js");

// Gmail REST is stubbed (no real Google account); everything else passes
// through. F-suite (email draft/send) is intentionally NOT run here.
const originalFetch = globalThis.fetch;
let gmailDraftSeq = 0;
(globalThis.fetch as unknown) = async (input: unknown, init?: { method?: string }): Promise<Response> => {
  const url = typeof input === "string" ? input : (input as { url: string } | null)?.url;
  if (typeof url === "string" && url.startsWith("https://gmail.googleapis.com/")) {
    const method = init?.method ?? "GET";
    const path = url.replace("https://gmail.googleapis.com", "");
    if (path.includes("/drafts") && method === "POST") {
      gmailDraftSeq += 1;
      return new Response(JSON.stringify({ id: `draft-${gmailDraftSeq}`, message: { id: `gmsg-${gmailDraftSeq}` } }), { status: 200 });
    }
    if (path.includes("/users/me/messages")) {
      // No real inbox data — executions surface/discard on empty data.
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (path.includes("/users/me/profile")) {
      return new Response(JSON.stringify({ emailAddress: "mimir-e2e@example.com" }), { status: 200 });
    }
  }
  return originalFetch(input as RequestInfo, init as RequestInit | undefined);
};

const prisma = getPrismaClient();
const PASSWORD = "password123";

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);
app.use("/api/v1", messageRouter);
const server = createServer(app);
const workers = startWorkers();

const users: string[] = [];
const conversations: string[] = [];
const agentIds: string[] = [];

async function cleanup(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  server.close();
  (globalThis.fetch as unknown) = originalFetch;
  await prisma.agentEvent.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.trigger.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.outboxEvent.deleteMany({
    where: { OR: [{ payload: { path: ["agentId"], equals: agentIds } }, { payload: { path: ["userId"], equals: users } }] },
  });
  await prisma.surfacedMail.deleteMany({ where: { userId: { in: users } } });
  await prisma.integrationConnection.deleteMany({ where: { userId: { in: users } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: conversations } } });
  await prisma.conversation.deleteMany({ where: { id: { in: conversations } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.usageRecord.deleteMany({ where: { userId: { in: users } } });
  await prisma.modelCallLog.deleteMany({ where: { userId: { in: users } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

async function registerUser(): Promise<{ accessToken: string; userId: string; port: number }> {
  const port = (server.address() as { port: number }).port;
  const email = `harness-${Date.now()}-${randomUUID()}@test.local`;
  const reg = await fetch(`http://localhost:${port}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const userId = (await reg.json()).user.id as string;
  users.push(userId);
  const cookie = (reg.headers.getSetCookie() ?? []).find((c) => c.startsWith("access_token="));
  const accessToken = cookie!.split(";").find((p) => p.startsWith("access_token="))!.slice("access_token=".length);
  return { accessToken, userId, port };
}

async function getConversation(port: number, accessToken: string): Promise<string> {
  const conv = await fetch(`http://localhost:${port}/api/v1/conversation`, { headers: { Cookie: `access_token=${accessToken}` } });
  const conversationId = (await conv.json()).conversation.id as string;
  conversations.push(conversationId);
  return conversationId;
}

async function runOne(entry: typeof corpus[number]): Promise<E2eResult> {
  const { accessToken, userId, port } = await registerUser();
  // Seed an active watch if the corpus expects one (so cancel prompts have state).
  if (entry.roster && entry.roster.length > 0) {
    const conv = await getConversation(port, accessToken);
    for (const r of entry.roster) {
      const agent = await prisma.agent.create({
        data: { id: `${userId}-${r.id}`, userId, ownerConversationId: conv, taskDescription: r.taskDescription, entity: "browser" },
      });
      agentIds.push(agent.id);
    }
  }
  // Record the pre-existing agent set so "agentCreated" means spawned-by-this-message.
  const conversationId = await getConversation(port, accessToken);
  const beforeAgents = new Set((await prisma.agent.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id));
  const res = await fetch(`http://localhost:${port}/api/v1/message`, {
    method: "POST",
    headers: { Cookie: `access_token=${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, content: entry.prompt, clientMessageId: randomUUID() }),
  });
  let reply = "";
  try {
    const body = (await res.json()) as { message?: { content?: string } };
    reply = body.message?.content ?? "";
  } catch {
    reply = `(http ${res.status})`;
  }
  const nowAgents = await prisma.agent.findMany({ where: { userId }, select: { id: true } });
  const createdHere = nowAgents.filter((a) => !beforeAgents.has(a.id)).map((a) => a.id);
  agentIds.push(...createdHere);
  const triggerCreated = (await prisma.trigger.count({ where: { agentId: { in: createdHere } } })) > 0;
  // Archive state of every seeded roster agent (rigorous cancel check).
  const archiveState: Record<string, string> = {};
  for (const r of entry.roster ?? []) {
    const seeded = await prisma.agent.findUnique({ where: { id: `${userId}-${r.id}` }, select: { status: true } });
    archiveState[r.id] = seeded?.status ?? "missing";
  }
  const result: E2eResult = {
    id: entry.id,
    mode: "e2e",
    prompt: entry.prompt,
    expected: entry.expected,
    reply,
    agentCreated: createdHere.length > 0,
    triggerCreated,
    outbox: [],
    archiveState,
    assertions: { ok: true, reasons: [] },
  };
  const ok = e2ePassed(entry, result);
  result.assertions = { ok, reasons: ok ? [] : e2eReasons(entry, result) };
  return result;
}

function e2eReasons(entry: typeof corpus[number], r: E2eResult): string[] {
  const reasons: string[] = [];
  const reply = r.reply;
  if (entry.expected.reply?.exact !== undefined && reply.trim() !== entry.expected.reply.exact) {
    reasons.push(`reply not exact: got "${reply.trim()}"`);
  }
  if (entry.expected.reply?.minLength !== undefined && reply.length < entry.expected.reply.minLength) reasons.push("reply too short");
  if (entry.expected.reply?.maxLength !== undefined && reply.length > entry.expected.reply.maxLength) reasons.push("reply too long");
  for (const m of entry.expected.reply?.mustContain ?? []) if (!reply.toLowerCase().includes(m.toLowerCase())) reasons.push(`missing "${m}"`);
  for (const n of entry.expected.reply?.mustNotContain ?? []) if (reply.toLowerCase().includes(n.toLowerCase())) reasons.push(`must not contain "${n}"`);
  for (const re of entry.expected.reply?.mustMatch ?? []) if (!re.test(reply)) reasons.push(`no match ${re}`);
  if (entry.expected.noAgent && r.agentCreated) reasons.push("Agent created but none expected");
  if (entry.expected.noTrigger && r.triggerCreated) reasons.push("Trigger created but none expected");
  for (const id of entry.expected.archives ?? []) {
    if (r.archiveState[id] !== "archived") reasons.push(`expected ${id} archived, got ${r.archiveState[id] ?? "missing"}`);
  }
  for (const id of entry.expected.notArchives ?? []) {
    if (r.archiveState[id] === "archived") reasons.push(`expected ${id} active, but archived`);
  }
  // Hygiene: the reply must never leak internals. "keep an eye"-style
  // reaffirmation is only a violation on a CANCEL prompt (a cancelled watch
  // being reinstated); on a keep/spawn prompt it is legitimate, so gate it.
  for (const re of MIMIR_STATUS_PATTERNS.leak) if (re.test(reply)) reasons.push(`internal leak matched ${re}`);
  if (entry.expected.action === "manage_cancel") {
    for (const re of MIMIR_STATUS_PATTERNS.sticky2026) if (re.test(reply)) reasons.push(`sticky/keep-an-eye matched ${re}`);
  }
  return reasons;
}

await new Promise<void>((resolve) => server.listen(0, resolve));

// Scope: the critical end-to-end hygiene guarantees — cancel/silence/adversarial
// must create NO agent/trigger and reply cleanly. Positive spawn correctness is
// already asserted by the fast classify loop, and the F-suite (draft/send/
// confirm) is covered by the existing e2e-ack.test.ts (needs connected-Gmail
// multi-turn state). This keeps the sweep fast and free of persisted executions.
const entries = corpus.filter(
  (e) =>
    e.expected.noAgent === true ||
    e.expected.noTrigger === true ||
    (e.expected.archives?.length ?? 0) > 0 ||
    (e.expected.notArchives?.length ?? 0) > 0,
).filter((e) => !e.id.startsWith("F"));

const results: E2eResult[] = [];
try {
  for (const e of entries) {
    process.stdout.write(`  ${e.id} ${e.prompt.slice(0, 50)}... `);
    let r: E2eResult;
    try {
      r = await runOne(e);
    } catch (err) {
      r = { id: e.id, mode: "e2e", prompt: e.prompt, expected: e.expected, reply: "", agentCreated: false, triggerCreated: false, outbox: [], archiveState: {}, assertions: { ok: false, reasons: [`run threw: ${(err as Error).message}`] } };
    }
    results.push(r);
    console.log(r.assertions.ok ? "PASS" : `FAIL [${r.assertions.reasons.join("; ")}]`);
  }
} finally {
  await cleanup();
}

const report = finalizeReport("e2e", results, entries, "e2e-" + new Date().toISOString().replace(/[:.]/g, "-"));
report.summary.byId = {};
let passed = 0;
for (const r of results) {
  report.summary.byId[r.id] = r.assertions.ok ? "PASS" : "FAIL";
  if (r.assertions.ok) passed += 1;
}
report.summary.passed = passed;
report.summary.failed = results.length - passed;
report.summary.passRate = results.length ? Math.round((passed / results.length) * 1000) / 10 : 0;

const path = writeReport(report);
console.log("\n" + renderReport(report));
console.log(`\nWrote ${path}`);
