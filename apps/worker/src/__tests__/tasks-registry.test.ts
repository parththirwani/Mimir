import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "tasks-registry-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { NOTION_INTEGRATION } = await import("@mimir/connection-provider");
const { agentTasksFor } = await import("../agent/tasks-registry.js");

const prisma = getPrismaClient();
const userId = `tasks-registry-${randomUUID()}`;
const email = `${userId}@test.local`;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
});

afterAll(async () => {
  await prisma.mcpServer.deleteMany({ where: { userId } });
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("agentTasksFor (4.9 per-user roster)", () => {
  test("browser task is always available", async () => {
    const tasks = await agentTasksFor(userId);
    expect(tasks.map((t) => t.name)).toContain("browser_fetch");
    expect(tasks.some((t) => t.name === "notion_search")).toBe(false);
  });

  test("notion task appears when the user has a connected Notion", async () => {
    await prisma.integrationConnection.create({
      data: { userId, provider: NOTION_INTEGRATION, nangoConnectionId: `nango-${userId}`, status: "connected" },
    });
    const tasks = await agentTasksFor(userId);
    expect(tasks.map((t) => t.name)).toContain("notion_search");
  });

  test("each tool of a connected MCP server becomes a namespaced task", async () => {
    const server = await prisma.mcpServer.create({
      data: {
        userId,
        name: "my-tools",
        url: "https://mcp.example.com/mcp",
        status: "connected",
        toolSchema: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
      },
    });
    const tasks = await agentTasksFor(userId);
    const mcpNames = tasks.map((t) => t.name).filter((n) => n.startsWith("mcp_"));
    expect(mcpNames).toEqual([`mcp_${server.id}_echo`]);
  });
});