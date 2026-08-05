import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "agent-tools-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { handleAgentTool } = await import("../agent/agent-execution.js");

const prisma = getPrismaClient();
const userId = `agent-tools-${randomUUID()}`;
const email = `${userId}@test.local`;

let agentId: string;
let conversationId: string;

const fakeResult = { model: "m", actualModel: "m2", usage: { totalTokens: 10 } };

// handleAgentTool publishes via redis; a live redis is up for tests, publish is fire-and-forget.
beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
  const agent = await prisma.agent.create({
    data: { userId, ownerConversationId: conversationId, taskDescription: "watch email" },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.agentEvent.deleteMany({ where: { agentId } });
  await prisma.trigger.deleteMany({ where: { agentId } });
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("wait tool (4.7.4)", () => {
  test("discards the run as AgentEvent{discarded} with reason wait_tool", async () => {
    const outcome = await handleAgentTool(
      agentId,
      userId,
      conversationId,
      { id: "tc-1", type: "function", function: { name: "wait", arguments: "{}" } },
      fakeResult,
    );
    expect(outcome.outcome).toBe("wait");

    const ev = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "discarded" }, orderBy: { createdAt: "desc" } });
    expect(ev).toBeDefined();
    expect((ev?.payload as { reason?: string }).reason).toBe("wait_tool");
  });
});

describe("draft tool (4.10)", () => {
  test("inserts verbatim content as a pending agent.draft message + surfaced event", async () => {
    const draftBody = "To: bob@example.com\nSubject: Hello\n\nBody line";
    const outcome = await handleAgentTool(
      agentId,
      userId,
      conversationId,
      {
        id: "tc-2",
        type: "function",
        function: { name: "draft", arguments: JSON.stringify({ content: draftBody, actionLabel: "send this email" }) },
      },
      fakeResult,
    );
    expect(outcome.outcome).toBe("draft");

    const msg = await prisma.message.findUnique({ where: { id: (outcome as { messageId: string }).messageId } });
    expect(msg).toBeDefined();
    expect(msg?.content).toBe(draftBody); // verbatim, no rewrite
    const t = msg?.toolCalls as { type?: string; status?: string; agentId?: string; draft?: { content?: string } };
    expect(t.type).toBe("agent.draft");
    expect(t.status).toBe("pending");
    expect(t.agentId).toBe(agentId);

    const ev = await prisma.agentEvent.findFirst({ where: { agentId, eventType: "surfaced" }, orderBy: { createdAt: "desc" } });
    expect(ev).toBeDefined();
    expect((ev?.payload as { category?: string }).category).toBe("draft");
  });

  test("throws when draft tool is called without content", async () => {
    expect(
      handleAgentTool(
        agentId,
        userId,
        conversationId,
        { id: "tc-3", type: "function", function: { name: "draft", arguments: "{}" } },
        fakeResult,
      ),
    ).rejects.toThrow();
  });
});