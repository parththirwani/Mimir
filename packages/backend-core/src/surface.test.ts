import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "surface-test-secret";

const { frameResultForUser } = await import("./prompts.js");

const LEAKY =
  "The only integration available is the browser (with no data loaded). There's no email, calendar, Notion, Linear, or other integration data in the current context to know what should be checked.";

describe("frameResultForUser", () => {
  test("routes the raw result through the interaction-agent persona", async () => {
    let seenSystem = "";
    let seenUser = "";
    const caller = async (messages: { role: string; content: string }[], options?: { useCase?: string }) => {
      seenSystem = String(messages[0]?.content ?? "");
      seenUser = String(messages.find((m) => m.role === "user")?.content ?? "");
      expect(options?.useCase).toBe("surface");
      return { content: "I couldn't find anything about that yet — could you tell me a bit more about what you'd like me to check?" };
    };
    const out = await frameResultForUser({ result: LEAKY, userMessage: "can you check once in 2026", caller });
    expect(out).toContain("could you tell me");
    // The interaction-agent persona is the system prompt (human, no tools).
    expect(seenSystem).toContain("You are Mimir");
    expect(seenSystem).toContain("NEVER output tool calls");
    // The raw leaky result was passed as user context, not output directly.
    expect(seenUser).toContain(LEAKY);
  });

  test("a compliant framed reply must not leak internals", async () => {
    const caller = async () => ({
      content: "I can check that for you, but I need a little more detail on what you're after. Just let me know!",
    });
    const out = await frameResultForUser({ result: LEAKY, userMessage: "check once in 2026", caller });
    expect(out).not.toMatch(/browser|Notion|Linear|Gmail|\bintegration\b|\bagent\b|no data loaded/i);
  });

  test("framing failure falls back to the raw result (best-effort)", async () => {
    const caller = async () => {
      throw new Error("boom");
    };
    const out = await frameResultForUser({ result: "raw fallback content", userMessage: "x", caller });
    expect(out).toBe("raw fallback content");
  });

  test("empty framed output falls back to the raw result", async () => {
    const caller = async () => ({ content: "   " });
    const out = await frameResultForUser({ result: "kept", userMessage: "x", caller });
    expect(out).toBe("kept");
  });
});
