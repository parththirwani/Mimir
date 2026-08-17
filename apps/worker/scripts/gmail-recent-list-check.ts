// Live check that the injected recent-mail list (fetchEntityData — the same
// path mail-poll cards render) now carries real From/Subject. Read-only. Run:
//   bun --env-file=../../.env scripts/gmail-recent-list-check.ts <userId>
import { fetchEntityData } from "../src/integrations/gmail/gmail.js";

const userId = process.argv[2];
if (!userId) throw new Error("usage: bun --env-file=../../.env scripts/gmail-recent-list-check.ts <userId>");

const data = await fetchEntityData(userId, "gmail", "");
const messages = (data as { messages: { id: string; from: string; subject: string; receivedAt: string }[] }).messages ?? [];

console.log("\n[recent-list] fetched", messages.length, "recent messages");
const blank = messages.filter((m) => !m.from || !m.subject);
for (const m of messages.slice(0, 4)) {
  console.log(`  ${m.receivedAt} | from=${m.from || "(blank)"} | subject=${m.subject || "(blank)"}`);
}
console.log("\n[recent-list] messages with blank From or Subject:", blank.length);

process.exit(0);
