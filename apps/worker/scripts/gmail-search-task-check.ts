// Scripted task-level verification (Bug 1): runs gmailSearchTask().execute
// exactly as the Execution Agent's tool loop would. Read-only. Run:
//   bun --env-file=../../.env scripts/gmail-search-task-check.ts <userId>
import { gmailSearchTask } from "../src/integrations/gmail/gmail.js";

const userId = process.argv[2];
if (!userId) throw new Error("usage: bun --env-file=../../.env scripts/gmail-search-task-check.ts <userId>");

const result = await gmailSearchTask().execute({ query: "from:openrouter" }, { userId });
const messages = (result as { messages: { id: string; from: string; subject: string; body: string; receivedAt: string }[] }).messages;

console.log("\n[search_email] query=from:openrouter ->", messages.length, "matches");
for (const m of messages.slice(0, 5)) {
  console.log(`  ${m.receivedAt} | from=${m.from || "(blank)"} | subject=${m.subject || "(blank)"} | snippet=${m.body.slice(0, 60)}`);
}

const blank = messages.filter((m) => !m.from || !m.subject);
console.log("\n[search_email] messages with blank From or Subject:", blank.length);

process.exit(0);
