import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "redis-helper-test-secret";

const { newMessagePayload } = await import("../infra/redis.js");

describe("newMessagePayload (11.4 push body)", () => {
  test("includes a content snippet", () => {
    const p = newMessagePayload("c1", { id: "m1", content: "Your inbox has an update." });
    expect(p).toEqual({ conversationId: "c1", messageId: "m1", content: "Your inbox has an update." });
  });

  test("truncates long content to the notification budget", () => {
    const p = newMessagePayload("c1", { id: "m1", content: "x".repeat(500) });
    expect(p.content!.length).toBe(160);
    expect(p.content!.endsWith("…")).toBe(true);
  });

  test("collapses newlines/whitespace to a single line", () => {
    const p = newMessagePayload("c1", { id: "m1", content: "line1\n\nline2    line3" });
    expect(p.content).toBe("line1 line2 line3");
  });

  test("omits content when absent so deliverToUser falls back to the event name", () => {
    expect(newMessagePayload("c1", { id: "m1" })).toEqual({ conversationId: "c1", messageId: "m1" });
    expect(newMessagePayload("c1", { id: "m1", content: "   " })).toEqual({ conversationId: "c1", messageId: "m1" });
  });
});