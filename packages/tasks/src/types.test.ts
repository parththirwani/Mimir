import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolError, toLlmTool } from "./index.js";

describe("toLlmTool", () => {
  test("emits an OpenAI-compatible function schema from a zod input schema", () => {
    const tool = toLlmTool({
      name: "gmail_search",
      description: "Search Gmail",
      inputSchema: z.object({ query: z.string() }),
    });
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("gmail_search");
    expect((tool.function.parameters as { type?: string }).type).toBe("object");
    expect((tool.function.parameters as { properties?: object }).properties).toBeDefined();
  });
});

describe("ToolError", () => {
  test("carries its kind", () => {
    const err = new ToolError("connection", "nango down");
    expect(err.kind).toBe("connection");
    expect(err.name).toBe("ToolError");
    expect(err.message).toBe("nango down");
  });
});
