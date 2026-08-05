import { getLogger, getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { listMcpTools } from "@mimir/tasks";
import { mcpServerSchema } from "@mimir/zod-schemas";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";

const prisma = getPrismaClient();

// User-added custom MCP servers (5.8) — a SEPARATE settings section from the
// managed integrations (gmail/notion via Nango). streamable-HTTP only, no stdio
// (arbitrary binary execution). Tool schema is fetched + cached on registration
// and re-fetched on demand; runtime errors stay generic Connection/Tool errors
// because we don't control the server.

export const mcpRouter: Router = Router();

const headersOf = (row: { headers: unknown }): Record<string, string> => (row.headers ?? {}) as Record<string, string>;

// POST /api/v1/mcp/servers — register + fetch/cache the tool schema.
mcpRouter.post("/mcp/servers", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const parsed = mcpServerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid MCP server payload" } });
    return;
  }
  const { name, url, headers } = parsed.data;

  let toolSchema: unknown[] = [];
  let status = "connected";
  let lastError: string | null = null;
  try {
    toolSchema = await listMcpTools(url, headers ?? {});
  } catch (e) {
    status = "error";
    lastError = (e as Error)?.message ?? String(e);
    getLogger().warn({ userId, url, err: lastError }, "mcp schema fetch failed at registration; saving as error");
  }

  const server = await prisma.mcpServer.create({
    data: {
      userId,
      name,
      url,
      headers: headers ?? {},
      toolSchema: toolSchema as unknown as InputJsonValue,
      status,
      lastError,
      lastSyncedAt: status === "connected" ? new Date() : null,
    },
  });
  res.status(201).json({ server });
});

// GET /api/v1/mcp/servers — list the user's servers with their cached schemas.
mcpRouter.get("/mcp/servers", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const servers = await prisma.mcpServer.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  res.json({ servers });
});

// POST /api/v1/mcp/servers/:id/sync — re-fetch the tool schema in place.
mcpRouter.post("/mcp/servers/:id/sync", requireAuth, async (req, res) => {
  const userId = req.userId;
  const serverId = String(req.params.id);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "MCP server not found" } });
    return;
  }
  try {
    const toolSchema = await listMcpTools(server.url, headersOf(server));
    const updated = await prisma.mcpServer.update({
      where: { id: server.id },
      data: {
        toolSchema: toolSchema as unknown as InputJsonValue,
        status: "connected",
        lastError: null,
        lastSyncedAt: new Date(),
      },
    });
    res.json({ server: updated });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    await prisma.mcpServer.update({ where: { id: server.id }, data: { status: "error", lastError: message } });
    res.status(502).json({ error: { code: "MCP_SYNC_FAILED", message } });
  }
});

// DELETE /api/v1/mcp/servers/:id — remove a server.
mcpRouter.delete("/mcp/servers/:id", requireAuth, async (req, res) => {
  const userId = req.userId;
  const serverId = String(req.params.id);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "MCP server not found" } });
    return;
  }
  await prisma.mcpServer.delete({ where: { id: server.id } });
  res.status(204).end();
});
