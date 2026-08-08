import { getConfig } from "@mimir/backend-core";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";
import Browserbase from "@browserbasehq/sdk";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { browserBudgetCheck, recordBrowserMinutes } from "../../infra/budget.js";

// Browser-use task (5.6): a hosted headless-browser session wrapped as a Task,
// ephemeral per run, domain-allowlisted, cost routed through the budget guard.
//
// HOSTED (not self-hosted Chromium) is deliberate: the worker process also runs
// agent/trigger/mail jobs, and rendering arbitrary third-party pages in-process
// is exactly the isolation boundary the plan worries about. A hosted session
// provider isolates page content (untrusted input) from the job processes for
// free. Cost is the tradeoff, routed through the Redis budget stub.

export interface HostedBrowserSession {
  title(): Promise<string>;
  text(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  open(url: string, waitForMs: number): Promise<HostedBrowserSession>;
}

// Domain allowlist + denylist gate. Empty allowlist = allow all (dev default);
// otherwise a strict hostname match. A denylist match always blocks (stronger
// than a missing allowlist entry). Consequential browser actions are gated
// separately by the agent's draft tool (4.10) — this boundaries WHAT can be
// visited.
export function assertAllowedUrl(raw: string, allowlist?: string[], denylist?: string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError("validation", "invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ToolError("validation", "only http(s) URLs allowed");
  }
  // Config is read lazily per call (not cached at import) so tests and live
  // config can diverge without polluting each other.
  const cfg = getConfig();
  const allow = allowlist ?? (cfg.BROWSER_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const deny = denylist ?? (cfg.BROWSER_DENIED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (deny.includes(host) || deny.some((d) => host.endsWith(`.${d}`))) {
    throw new ToolError("blocked", `domain ${host} denied`);
  }
  if (allow.length > 0 && !allow.includes(host)) {
    throw new ToolError("blocked", `domain ${host} not allowlisted`);
  }
  return u;
}

// Default runtime: Browserbase hosted session + puppeteer-core (no Chromium
// download — connects over CDP to the hosted browser). Session is ephemeral per
// run and always terminated.
const defaultRuntime: BrowserRuntime = {
  open: async (url, waitForMs) => {
    const cfg = getConfig();
    if (!cfg.BROWSERBASE_API_KEY) throw new ToolError("connection", "BROWSERBASE_API_KEY is not configured");
    const client = new Browserbase({ apiKey: cfg.BROWSERBASE_API_KEY });
    const session = await client.sessions.create({ projectId: cfg.BROWSERBASE_PROJECT_ID });
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (waitForMs > 0) await new Promise((r) => setTimeout(r, waitForMs));
      return {
        title: () => page.title(),
        text: () => page.evaluate(() => document.body.innerText),
        close: async () => {
          await browser?.close().catch(() => {});
          await client.sessions.update(session.id, { status: "REQUEST_RELEASE" }).catch(() => {});
        },
      };
    } catch (e) {
      await client.sessions.update(session.id, { status: "REQUEST_RELEASE" }).catch(() => {});
      throw e;
    }
  },
};

export function browserFetchTask(runtime: BrowserRuntime = defaultRuntime, opts: { allowlist?: string[] } = {}): Task {
  return {
    kind: "task",
    name: "browser_fetch",
    description: "Fetch the text content of a single page in a hosted headless browser. Domain allowlisted. For live web lookups, pass a search-engine results page URL (e.g. https://html.duckduckgo.com/html/?q=...).",
    inputSchema: z.object({
      url: z.string(),
      waitForMs: z.number().int().min(0).max(15000).optional(),
    }),
    execute: async (input, ctx) => {
      const { url, waitForMs = 0 } = input as { url: string; waitForMs?: number };
      const parsed = assertAllowedUrl(url, opts.allowlist);
      if (!(await browserBudgetCheck(ctx.userId))) {
        throw new ToolError("blocked", "daily browser budget exhausted");
      }
      const started = Date.now();
      const session = await runtime.open(parsed.href, waitForMs);
      try {
        const [title, text] = await Promise.all([session.title(), session.text()]);
        const minutes = (Date.now() - started) / 60000;
        await recordBrowserMinutes(ctx.userId, minutes);
        return { url: parsed.href, title, text };
      } finally {
        await session.close().catch(() => {});
      }
    },
  };
}