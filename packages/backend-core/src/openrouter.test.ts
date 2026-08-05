import { describe, expect, test } from "bun:test";

// openrouter.ts imports observability -> config, which validates env at import.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "openrouter-test-secret";

const { toWireMessages } = await import("./openrouter.js");

describe("toWireMessages (OpenRouter tool-loop wire format)", () => {
  test("passes plain messages through unchanged", () => {
    expect(toWireMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });

  test("maps assistant toolCalls to snake_case tool_calls", () => {
    const out = toWireMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }] },
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }],
    });
    expect(out[0]).not.toHaveProperty("toolCalls");
  });

  test("maps tool result toolCallId to snake_case tool_call_id", () => {
    const out = toWireMessages([{ role: "tool", content: "{\"ok\":true}", toolCallId: "call-1" }]);
    expect(out[0]).toEqual({ role: "tool", content: "{\"ok\":true}", tool_call_id: "call-1" });
    expect(out[0]).not.toHaveProperty("toolCallId");
  });
});
