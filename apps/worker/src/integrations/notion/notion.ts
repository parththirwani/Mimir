import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { notionProvider } from "@mimir/connection-provider";
import { ConnectionError, ProviderError } from "@mimir/connection-provider";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";

const prisma = getPrismaClient();

const NOTION_API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedAt: string | null;
}

// Real Notion REST behind the same shape the agent consumes. Notion's search
// endpoint is a POST with a query; results carry the page title from its title
// property. Split from the token plumbing so the REST layer is unit-testable.
export async function fetchNotionPages(token: string, query: string): Promise<NotionPage[]> {
  const res = await fetch(`${NOTION_API}/v1/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: query || undefined, page_size: 20 }),
  });
  if (res.status === 401 || res.status === 403) throw new ConnectionError("expired", "notion access token rejected");
  if (res.status === 429) throw new ProviderError("rate_limited", "notion rate limited");
  if (res.status >= 500) throw new ProviderError("provider_down", `notion api ${res.status}`);
  if (!res.ok) throw new Error(`notion api returned ${res.status}`);
  const json = (await res.json()) as { results?: { id?: string; url?: string; last_edited_time?: string; properties?: Record<string, { title?: { plain_text?: string }[] }> }[] };
  return (json.results ?? []).map((r) => ({
    id: r.id ?? "",
    title: r.properties?.title?.title?.[0]?.plain_text ?? "",
    url: r.url ?? "",
    lastEditedAt: r.last_edited_time ?? null,
  }));
}

// Composite Task (5.7): one aggregated "search my Notion" result from a single
// token resolve + REST round-trip. Same ConnectionProvider/Task pattern as Gmail.
export function notionSearchTask(): Task {
  return {
    kind: "task",
    name: "notion_search",
    description: "Search the user's connected Notion workspace for pages matching a query.",
    inputSchema: z.object({ query: z.string() }),
    execute: async (input, ctx) => {
      const { query } = input as { query: string };
      const cfg = getConfig();
      const provider = notionProvider({
        secretKey: cfg.NANGO_SECRET_KEY,
        host: cfg.NANGO_BASE_URL,
        store: prisma.integrationConnection,
      });
      let token: string;
      try {
        token = await provider.getAccessToken(ctx.userId);
      } catch (e) {
        if (e instanceof ConnectionError) throw new ToolError("connection", e.message);
        throw e;
      }
      try {
        return { provider: "notion", pages: await fetchNotionPages(token, query) };
      } catch (e) {
        if (e instanceof ConnectionError) throw new ToolError("connection", e.message);
        if (e instanceof ProviderError) throw new ToolError("execution", e.message);
        throw e;
      }
    },
  };
}