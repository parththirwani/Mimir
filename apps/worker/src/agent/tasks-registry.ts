import { getPrismaClient } from "@mimir/backend-core";
import { NOTION_INTEGRATION } from "@mimir/connection-provider";
import type { McpToolSchema, Task } from "@mimir/tasks";
import { browserFetchTask } from "../integrations/browser/browser-task.js";
import { mcpToolTask } from "../integrations/mcp/mcp-task.js";
import { notionSearchTask } from "../integrations/notion/notion.js";

const prisma = getPrismaClient();

// The per-user task roster (4.9): what the execution agent can invoke beyond the
// system tools (wait/draft). browser is always available; notion is available
// when the user has a connected Notion; registered MCP servers (5.8) expose each
// of their tools as a dynamic Task. The agent LLM sees the union via toLlmTool.
export async function agentTasksFor(userId: string): Promise<Task[]> {
  const tasks: Task[] = [browserFetchTask()];

  const notion = await prisma.integrationConnection.findFirst({
    where: { userId, provider: NOTION_INTEGRATION },
    select: { id: true },
  });
  if (notion) tasks.push(notionSearchTask());

  const servers = await prisma.mcpServer.findMany({ where: { userId, status: "connected" } });
  for (const server of servers) {
    const tools = (server.toolSchema ?? []) as unknown as McpToolSchema[];
    for (const tool of tools) {
      tasks.push(mcpToolTask(server.id, tool));
    }
  }
  return tasks;
}
