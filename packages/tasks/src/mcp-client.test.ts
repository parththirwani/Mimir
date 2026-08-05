import { afterAll, describe, expect, test } from "bun:test";
import { ToolError } from "./types.js";
import { callMcpTool, listMcpTools } from "./mcp-client.js";

const noHeaders = {};

// bun runs all test files in one process; a leaked fetch mock breaks every
// fetch-based test that runs after this file (e.g. the api e2e). Restore it.
const originalFetch = globalThis.fetch;
afterAll(() => {
  (globalThis.fetch as unknown) = originalFetch;
});

function mockFetch(handler: (url: string, init: { body?: string }) => Response | Promise<Response>): void {
  (globalThis.fetch as unknown) = async (url: unknown, init: { body?: string }) => handler(String(url), init);
}

describe("listMcpTools (streamable-HTTP)", () => {
  test("handshakes (initialize + initialized) then returns the cached tool list", async () => {
    const seen: string[] = [];
    mockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}");
      seen.push(body.method);
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }), {
          headers: { "Mcp-Session-Id": "sess-1", "Content-Type": "application/json" },
        });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const tools = await listMcpTools("https://mcp.example.com/mcp", noHeaders);
    expect(tools).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
    expect(seen).toContain("initialize");
    expect(seen).toContain("notifications/initialized");
    expect(seen).toContain("tools/list");
  });

  test("maps transport failures to ToolError(connection)", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(listMcpTools("https://down.example.com/mcp", noHeaders)).rejects.toThrow(ToolError);
    await expect(listMcpTools("https://down.example.com/mcp", noHeaders)).rejects.toThrow(/unreachable/);
  });

  test("maps non-2xx to ToolError(connection) and RPC errors to ToolError(execution)", async () => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(listMcpTools("https://mcp.example.com/mcp", noHeaders)).rejects.toThrow(/method not found/);

    mockFetch(async () => new Response("boom", { status: 500 }));
    await expect(listMcpTools("https://down.example.com/mcp", noHeaders)).rejects.toThrow(/500/);
  });
});

describe("callMcpTool", () => {
  test("sends tools/call with args and returns the result", async () => {
    let calledWith: { name?: string; arguments?: unknown } | undefined;
    mockFetch(async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (body.method === "tools/call") {
        calledWith = body.params;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "hi" }] } }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const out = await callMcpTool("https://mcp.example.com/mcp", noHeaders, "echo", { msg: "hi" });
    expect(calledWith).toEqual({ name: "echo", arguments: { msg: "hi" } });
    expect(out).toEqual({ content: [{ type: "text", text: "hi" }] });
  });
});
