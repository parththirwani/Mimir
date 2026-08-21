import { ToolError } from "./types.js";

// Minimal MCP streamable-HTTP client. User-supplied servers are outside
// our control, so error mapping stays generic: transport failures ->
// ToolError("connection"), RPC/tool failures -> ToolError("execution"). No
// bespoke per-server mapping.
//
// stdio is deliberately NOT offered here (spawning a user-supplied binary on our
// infra is arbitrary code execution). streamable-HTTP only for v1.

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface RpcResult {
  result?: unknown;
  sessionId?: string;
}

let nextId = 1;

async function rpc(
  url: string,
  headers: Record<string, string>,
  method: string,
  params: unknown,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<RpcResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: signal ?? AbortSignal.timeout(30000),
    });
  } catch {
    throw new ToolError("connection", "mcp server unreachable");
  }
  if (!res.ok) throw new ToolError("connection", `mcp server returned ${res.status}`);

  const newSession = res.headers.get("Mcp-Session-Id") ?? undefined;
  const ct = res.headers.get("content-type") ?? "";
  let json: { result?: unknown; error?: { code?: number; message?: string } };
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    json = JSON.parse((dataLine ?? text).replace(/^data:\s*/, "")) as typeof json;
  } else {
    json = (await res.json()) as typeof json;
  }
  if (json.error) throw new ToolError("execution", json.error.message ?? `mcp error ${String(json.error.code)}`);
  return { result: json.result, sessionId: newSession };
}

export async function mcpInitialize(url: string, headers: Record<string, string>): Promise<string | undefined> {
  const { sessionId } = await rpc(url, headers, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mimir", version: "0.1.0" },
  });
  // initialized is a notification — fire and forget; a missing session id just
  // means the server doesn't require one.
  void rpc(url, headers, "notifications/initialized", {}).catch(() => {});
  return sessionId;
}

export async function listMcpTools(url: string, headers: Record<string, string>): Promise<McpToolSchema[]> {
  const sessionId = await mcpInitialize(url, headers);
  const { result } = await rpc(url, headers, "tools/list", {}, sessionId);
  const tools = (result as { tools?: McpToolSchema[] })?.tools ?? [];
  return tools;
}

export async function callMcpTool(
  url: string,
  headers: Record<string, string>,
  name: string,
  args: unknown,
): Promise<unknown> {
  const sessionId = await mcpInitialize(url, headers);
  const { result } = await rpc(url, headers, "tools/call", { name, arguments: args }, sessionId);
  return result;
}
