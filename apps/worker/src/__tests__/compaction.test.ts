import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "compaction-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { foldOldEvents } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `compact-${randomUUID()}`;
const convId = `compact-conv-${randomUUID()}`;

// Prune is in-place (no deletion); oversized result payloads get truncated.
let agentId = "";

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: convId, userId } });
  const agent = await prisma.agent.create({ data: { userId, ownerConversationId: convId, taskDescription: "t" } });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.agentEvent.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.delete({ where: { id: userId } });
});

// Real LLM would be called only when the budget is STILL over after pruning;
// that's the Summarize stage. We stub the caller by never reaching it — the
// prune-only assertion below triggers no LLM, so foldOldEvents needs no LLM.
describe("foldOldEvents — 10.7 two-stage compaction", () => {
  test("prune stage truncates oversized event payloads and writes a 'pruned' audit row", async () => {
    // One surfaced event whose result payload alone exceeds the 8k-token
    // (~32k char) budget, so pruning it to <=4k chars gets the window under
    // budget with NO summarize call (nothing falls through to the LLM).
    await prisma.agentEvent.create({
      data: { agentId, eventType: "surfaced", payload: { result: "x".repeat(40_000), category: "actionable" } },
    });

    await foldOldEvents(agentId);

    const events = await prisma.agentEvent.findMany({ where: { agentId } });
    // the oversized surfaced row remains (prune is in-place, no deletion),
    // plus the 'pruned' audit event created by the prune stage.
    expect(events.filter((e) => e.eventType === "surfaced")).toHaveLength(1);
    const surfaced = events.find((e) => e.eventType === "surfaced");
    const result = (surfaced!.payload as Record<string, unknown>).result as string;
    expect(result.length).toBeLessThanOrEqual(4_000 + 32); // PRUNE_PAYLOAD_BYTES + trunc marker
    // Audit trail: a 'pruned' event exists, and no 'summarized' (prune sufficed).
    const pruned = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "pruned" } });
    const summarized = await prisma.agentEvent.findMany({ where: { agentId, eventType: "summarized" } });
    expect(pruned).not.toBeNull();
    expect(summarized).toHaveLength(0);
  });
});