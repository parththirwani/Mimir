import { getLogger, getPrismaClient } from "@mimir/backend-core";
import { callMcpTool, ToolError, type InputSchema, type Task } from "@mimir/tasks";

const prisma = getPrismaClient();

// MCP tool wrapper (5.8): a registered server's tool becomes a dynamic Task the
// agent can invoke. The server row is re-loaded at execution time so the cached
// schema/config stays current, and ownership is re-verified (the row must belong
// to the run's user). Errors stay generic ConnectionError/ToolError — we don't
// control the server, so we don't map its errors.

export function mcpToolTask(serverId: string, tool: { name: string; description?: string; inputSchema: InputSchema }): Task {
  return {
    kind: "task",
    name: `mcp_${serverId}_${tool.name}`,
    description: tool.description ?? `Call MCP tool ${tool.name}`,
    inputSchema: tool.inputSchema,
    execute: async (input, ctx) => {
      const server = await prisma.mcpServer.findUnique({ where: { id: serverId } });
      if (!server || server.userId !== ctx.userId) {
        throw new ToolError("unavailable", "mcp server not found for this user");
      }
      const headers = (server.headers ?? {}) as Record<string, string>;
      try {
        return await callMcpTool(server.url, headers, tool.name, input);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        getLogger().error({ err: e, serverId, tool: tool.name }, "mcp tool call failed");
        throw new ToolError("execution", "mcp tool call failed");
      }
    },
  };
}
