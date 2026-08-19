import { describe, expect, test } from "bun:test";

// Must be set before @mimir/backend-core is imported (validates env at load).
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "context-test-secret";

const { factContextBlock, lastNMessages, shouldFetchFacts } = await import("../routes/message.js");

describe("reply context window (10.2.1)", () => {
  test("newest-first DB rows are returned oldest->newest within the last 50", () => {
    // Simulates orderBy createdAt desc, take 50 for a 60-message thread:
    // DB rows newest-first are 59, 58, ..., 10 (the oldest 10 are dropped).
    const rows = Array.from({ length: 50 }, (_, i) => 59 - i);
    const window = lastNMessages(rows);
    expect(window).toHaveLength(50);
    expect(window[0]).toEqual(10); // oldest retained — NOT the oldest-50 bug
    expect(window[window.length - 1]).toEqual(59); // most recent
    expect(window[0]).not.toEqual(0); // the oldest-50 bug would start at 0
  });

  test("window unchanged when under 50 rows", () => {
    const rows = [2, 1, 0]; // newest-first: 2 newest, 0 oldest
    expect(lastNMessages(rows)).toEqual([0, 1, 2]);
  });
});

describe("fact context block (10.2.2)", () => {
  test("renders subject: fact lines", () => {
    const block = factContextBlock([
      { subject: "rent", fact: "new rent is $1,200 starting December" },
      { subject: "move", fact: "moving to Portland" },
    ]);
    expect(block).toBe(
      "Relevant facts from earlier in this thread:\n" +
        "- rent: new rent is $1,200 starting December\n" +
        "- move: moving to Portland",
    );
  });

  test("empty facts inject nothing", () => {
    expect(factContextBlock([])).toBeNull();
  });
});

describe("fact retrieval cost gate (10.2.2)", () => {
  test("searchActiveFacts is skipped below the window size (no embed cost)", () => {
    expect(shouldFetchFacts(0)).toBe(false);
    expect(shouldFetchFacts(49)).toBe(false);
  });

  test("facts are fetched exactly once the window fills", () => {
    expect(shouldFetchFacts(50)).toBe(true);
    expect(shouldFetchFacts(200)).toBe(true);
  });
});