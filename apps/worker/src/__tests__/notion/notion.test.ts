import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "notion-test-secret";

const { ConnectionError, ProviderError } = await import("@mimir/connection-provider");
const { fetchNotionPages } = await import("../../integrations/notion/notion.js");

// Restore the real fetch so a later test file's HTTP calls aren't hijacked.
const originalFetch = globalThis.fetch;
afterAll(() => {
  (globalThis.fetch as unknown) = originalFetch;
});

function mockFetch(json: unknown, status = 200): void {
  (globalThis.fetch as unknown) = async () =>
    new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchNotionPages (REST layer)", () => {
  test("maps search results to the page shape", async () => {
    mockFetch({
      results: [
        { id: "p1", url: "https://notion.so/p1", last_edited_time: "2024-08-02T12:00:00.000Z",
          properties: { title: { title: [{ plain_text: "Q3 Plans" }] } } },
      ],
    });
    const pages = await fetchNotionPages("tok", "plans");
    expect(pages).toEqual([
      { id: "p1", title: "Q3 Plans", url: "https://notion.so/p1", lastEditedAt: "2024-08-02T12:00:00.000Z" },
    ]);
  });

  test("maps auth errors to ConnectionError (fail-fast reconnect)", async () => {
    mockFetch({ message: "unauthorized" }, 401);
    await expect(fetchNotionPages("tok", "x")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("maps provider outages to ProviderError (retriable)", async () => {
    mockFetch({ message: "down" }, 503);
    await expect(fetchNotionPages("tok", "x")).rejects.toBeInstanceOf(ProviderError);
  });
});