// Live Gmail probe — Bug 2 (blank headers) + Bug 1 (search) against the real inbox.
// Read-only: GETs only, no writes. Run:
//   bun --env-file=.env scripts/gmail-live-probe.ts <userId>
import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { gmailProvider } from "@mimir/connection-provider";
import type { GmailTransport } from "../src/integrations/gmail/gmail.js";

const prisma = getPrismaClient();
const cfg = getConfig();

const userId = process.argv[2];
if (!userId) throw new Error("usage: bun --env-file=.env scripts/gmail-live-probe.ts <userId>");

const provider = gmailProvider(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
const transport: GmailTransport = (path, opts) => provider.gmailRequest(userId, path, opts);

// ---- Bug 2: is the drop upstream (transport) or in local parsing? ----
const list = (await transport("/gmail/v1/users/me/messages", { query: { maxResults: 1 } })).data as { messages?: { id: string }[] };
const id = list.messages?.[0]?.id;
console.log("\n[Bug 2] probe message id =", id);

// format=metadata + repeated metadataHeaders.
const withMeta = (await transport(`/gmail/v1/users/me/messages/${id}`, {
  query: { format: "metadata", metadataHeaders: ["From", "Subject", "List-Unsubscribe", "In-Reply-To"] },
})).data as { payload?: { headers?: { name: string; value: string }[] } };
console.log("[Bug 2] format=metadata + repeated metadataHeaders ->", (withMeta.payload?.headers ?? []).map((h) => h.name).join(", ") || "(no headers returned)");

// format=metadata alone, Gmail returns all headers.
const bare = (await transport(`/gmail/v1/users/me/messages/${id}`, {
  query: { format: "metadata" },
})).data as { payload?: { headers?: { name: string; value: string }[] } };
const headers = bare.payload?.headers ?? [];
const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
console.log("[Bug 2] format=metadata only (fix) ->", headers.map((h) => h.name).join(", "));
console.log("[Bug 2]   From =", get("From"));
console.log("[Bug 2]   Subject =", get("Subject"));

// ---- Bug 1: does messages.list?q= actually search? ----
const search = (await transport("/gmail/v1/users/me/messages", { query: { maxResults: 20, q: "from:openrouter" } })).data as { messages?: { id: string }[]; resultSizeEstimate?: number };
console.log("\n[Bug 1] q=from:openrouter -> resultSizeEstimate:", search.resultSizeEstimate, "| messages:", search.messages?.length);
for (const m of (search.messages ?? []).slice(0, 3)) {
  const d = (await transport(`/gmail/v1/users/me/messages/${m.id}`, { query: { format: "metadata" } })).data as { payload?: { headers?: { name: string; value: string }[] } };
  const h = (d.payload?.headers ?? []).filter((x) => ["From", "Subject", "Date"].includes(x.name));
  console.log(`  ${m.id}: ${h.map((x) => `${x.name}=${x.value}`).join(" | ")}`);
}

process.exit(0);
