import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "browser-task-test-secret";

const { ToolError } = await import("@mimir/tasks");
const { browserFetchTask, assertAllowedUrl } = await import("../../integrations/browser/browser-task.js");
const { browserBudgetCheck, recordBrowserMinutes } = await import("../../infra/budget.js");

// Explicit allowlist — no reliance on process env (config is cached globally and
// shared across test files in one run).
const ALLOW = ["example.com", "google.com"];

describe("assertAllowedUrl (5.6 domain allowlist)", () => {
  test("accepts allowlisted hosts", () => {
    expect(assertAllowedUrl("https://example.com/page", ALLOW).hostname).toBe("example.com");
    expect(assertAllowedUrl("http://google.com", ALLOW).hostname).toBe("google.com");
  });

  test("blocks non-allowlisted hosts with a ToolError", () => {
    expect(() => assertAllowedUrl("https://evil.example.org", ALLOW)).toThrow(ToolError);
    expect(() => assertAllowedUrl("https://evil.example.org", ALLOW)).toThrow(/not allowlisted/);
  });

  test("rejects malformed URLs and non-http protocols", () => {
    expect(() => assertAllowedUrl("not a url", ALLOW)).toThrow(ToolError);
    expect(() => assertAllowedUrl("file:///etc/passwd", ALLOW)).toThrow(/only http\(s\)/);
  });
});

describe("browserFetchTask", () => {
  const fakeRuntime = {
    open: async () => ({
      title: async () => "Example",
      text: async () => "Hello world",
      close: async () => {},
    }),
  };

  test("returns page title + text via a hosted session", async () => {
    const task = browserFetchTask(fakeRuntime, { allowlist: ALLOW });
    const out = (await task.execute({ url: "https://example.com" }, { userId: `browser-ok-${randomUUID()}` })) as {
      url: string;
      title: string;
      text: string;
    };
    expect(out.title).toBe("Example");
    expect(out.text).toBe("Hello world");
    expect(out.url).toBe("https://example.com/"); // URL normalized via new URL().href
  });

  test("blocks a non-allowlisted URL before touching the runtime", async () => {
    const opened = { count: 0 };
    const runtime = {
      open: async () => {
        opened.count += 1;
        return { title: async () => "", text: async () => "", close: async () => {} };
      },
    };
    const task = browserFetchTask(runtime, { allowlist: ALLOW });
    await expect(task.execute({ url: "https://bad.example.org" }, { userId: `browser-blk-${randomUUID()}` })).rejects.toThrow(/not allowlisted/);
    expect(opened.count).toBe(0);
  });

  test("refuses to run when the daily browser budget is exhausted", async () => {
    const userId = `browser-budget-${randomUUID()}`;
    await recordBrowserMinutes(userId, 30);
    expect(await browserBudgetCheck(userId)).toBe(false);

    const task = browserFetchTask(fakeRuntime, { allowlist: ALLOW });
    await expect(task.execute({ url: "https://example.com" }, { userId })).rejects.toThrow(/budget exhausted/);
  });
});