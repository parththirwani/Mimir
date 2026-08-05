import { describe, expect, test } from "bun:test";

// ack.ts imports observability -> config, which validates env at import.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "ack-test-secret";

// Force the fallback path deterministically (no real LLM call): an injected
// caller that always throws, so generateAck returns the kind's fallback line.
// Injected via the test seam instead of mock.module — bun test runs every file
// in ONE process, so a module mock on openrouter would leak to the e2e files
// that need the real LLM.
const failingCaller = async () => {
  throw new Error("forced ack failure");
};

const { ACK_FALLBACKS, generateAck } = await import("./ack.js");

describe("ack generation", () => {
  test("every kind has a fallback line", () => {
    const kinds = ["draft", "send", "spawn", "retarget", "agent_draft_confirm", "send_result", "send_failed"];
    for (const kind of kinds) {
      expect(ACK_FALLBACKS[kind as keyof typeof ACK_FALLBACKS]).toBeTruthy();
    }
  });

  test("LLM failure falls back to the kind's fallback line", async () => {
    expect(await generateAck("send", {}, { callOpenRouter: failingCaller })).toBe(ACK_FALLBACKS.send);
  });

  test("a custom fallback is used on LLM failure", async () => {
    expect(
      await generateAck("send_result", { fallback: 'Sent to alice@example.com: "Hi".' }, { callOpenRouter: failingCaller }),
    ).toBe('Sent to alice@example.com: "Hi".');
  });
});
