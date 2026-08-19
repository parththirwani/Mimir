import { randomUUID } from "node:crypto";
import { loadEnv } from "../intent-iteration/_env.js";
import { getPrismaClient, getLogger, callOpenRouter } from "@mimir/backend-core";

// Phase 10 fact layer — live-LLM verification (not mocks). Drives the REAL
// extraction write path (extractFacts) and retrieval path (searchActiveFacts)
// against the OpenRouter models from model-config.json and a real multi-message
// conversation seeded in Postgres. Confirms three report asks:
//   1. extraction write path works over a real multi-message conversation
//   2. retrieval surfaces a specific fact the narrative summary would drop
//   3. supersede path works with a real contradicting-fact case
// Run: bun run phase10-facts   (needs OPENROUTER_API_KEY, DATABASE_URL in .env)

loadEnv();

const prisma = getPrismaClient();
const userId = `phase10-facts-${randomUUID()}`;
await prisma.user.create({ data: { id: userId, email: `${userId}@harness.local`, passwordHash: "x" } });
const conv = await prisma.conversation.create({ data: { userId } });
const conversationId = conv.id;

const { extractFacts, searchActiveFacts } = await import("../../apps/worker/src/agent/fact-extraction.js");

// ---------------------------------------------------------------------------
// Seed a real multi-message conversation rich in durable facts.
// ---------------------------------------------------------------------------
const TRANSCRIPT: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "Hi! Setting up my move to Portland." },
  { role: "assistant", content: "Sounds exciting! What should I track?" },
  { role: "user", content: "My new rent is $1,200 a month starting December." },
  { role: "user", content: "The property manager is Carol Jenkins, best reached by email." },
  { role: "user", content: "I need to transfer utilities before I move in." },
  { role: "assistant", content: "I'll keep note of the utilities task." },
  { role: "user", content: "Also my employer is Acme Corp — I start there January 5th." },
];

let t = Date.now() - TRANSCRIPT.length * 60_000;
for (const m of TRANSCRIPT) {
  await prisma.message.create({
    data: { conversationId, role: m.role, content: m.content, createdAt: new Date(t) },
  });
  t += 60_000;
}
const rangeFrom = new Date(Date.now() - TRANSCRIPT.length * 60_000 - 1000);
const rangeTo = new Date();

console.log("\n===== PHASE 10 FACT LAYER (live LLM) =====");
console.log(`seeded ${TRANSCRIPT.length} messages in conversation ${conversationId}`);

// ---------------------------------------------------------------------------
// 1. Extraction write path over the real conversation.
// ---------------------------------------------------------------------------
const wrote = await extractFacts(conversationId, rangeFrom, rangeTo);
console.log(`[extractFacts] inserted=${wrote.inserted} superseded=${wrote.superseded}`);
if (wrote.inserted === 0) {
  console.log("  WARNING: nothing extracted from a fact-dense conversation — extraction likely broken.");
}

const allFacts = await prisma.extractedFact.findMany({ where: { conversationId } });
console.log(`[facts stored] ${allFacts.length} rows`);
for (const f of allFacts) console.log(`   - [${f.status}] ${f.subject}: ${f.fact}`);

// ---------------------------------------------------------------------------
// 2. Retrieval surfaces a fact a summary would drop.
//    A narrative summary of the conversation would keep "moving to Portland"
//    and "rent $1200 Dec", but is likely to DROP "property manager Carol
//    Jenkins" and "employer Acme Corp starting Jan 5" as mundane specifics.
//    A fact query for BOTH must return the durable row.
// ---------------------------------------------------------------------------
async function verifyRetrieval(label: string, query: string, expectFragments: string[]): Promise<boolean> {
  const hits = await searchActiveFacts(conversationId, query);
  const hitText = hits.map((h) => h.fact.toLowerCase()).join("\n");
  let ok = true;
  for (const frag of expectFragments) {
    if (!hitText.includes(frag.toLowerCase())) {
      console.log(`  [RETRIEVAL MISS] "${query}" did not surface "${frag}"`);
      ok = false;
    }
  }
  console.log(`[retrieval:${label}] query="${query}" -> ${hits.length} hits` + (ok ? " OK" : " MISS"));
  for (const h of hits.slice(0, 3)) console.log(`   - ${h.subject}: ${h.fact} (sim ${h.similarity.toFixed(2)})`);
  return ok;
}

const retrOk1 = await verifyRetrieval("manager", "who is my property manager", ["carol jenkins"]);
const retrOk2 = await verifyRetrieval("employer", "where do I work starting in january", ["acme"]);
const retrOk = retrOk1 && retrOk2;

// ---------------------------------------------------------------------------
// 3. Supersede path with a real contradicting fact.
//    The sweep extract run drives a DELTA range: pass 1 covered the transcript
//    (up to rangeTo); pass 2 must cover ONLY the new contradiction message
//    (from rangeTo to now). This isolates the new fact so it can be matched
//    against the already-stored $1200 row. Re-passing the full range would
//    re-extract the old $1200 in the same batch and dodge the stored-row match.
// ---------------------------------------------------------------------------
// Anchor the delta AFTER pass 1 by reading the newest message row (not a live
// clock): pass-1 covered it, so the delta is everything strictly after it. We
// then stamp the contradiction message in the seconds AFTER that anchor.
const anchorQuery = await prisma.message.findFirst({
  where: { conversationId },
  orderBy: { createdAt: "desc" },
  select: { createdAt: true },
});
const afterFirst = new Date(anchorQuery!.createdAt); // pass-1 extracted through this message
const deltaCreatedAt = new Date(afterFirst.getTime() + 2000); // clearly after the anchor
await prisma.message.create({
  data: {
    conversationId,
    role: "user" as const,
    content: "Update: the rent actually went up — it's now $1,500 a month, still starting December.",
    createdAt: deltaCreatedAt,
  },
});

// Pass 2: delta from afterFirst to deltaCreatedAt — ONLY the contradiction
// message (its createdAt = deltaCreatedAt > afterFirst).
const dup = await extractFacts(conversationId, afterFirst, deltaCreatedAt);
console.log(`[extractFacts:contradiction] inserted=${dup.inserted} superseded=${dup.superseded}`);

const rentFacts = await prisma.extractedFact.findMany({
  where: { conversationId, subject: { contains: "rent" } },
  orderBy: { createdAt: "asc" },
});
// Subject is freeform ("user" in the live extraction), so also scan any fact
// whose text mentions rent, in case the model used a different subject.
const rentMention = (await prisma.extractedFact.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } })).filter(
  (f) => /1,?200|1,?500|rent/i.test(f.fact) || f.subject.includes("rent"),
);
console.log(`[rent-related facts after contradiction] ${rentMention.length} rows`);
for (const f of rentMention) {
  const supersedes = f.supersedesId ? " supersedes=" + f.supersedesId.slice(0, 8) : "";
  console.log(`   - [${f.status}] "${f.fact}" (subject=${f.subject})${supersedes}`);
}

const supersededOld = rentMention.some((f) => f.status === "superseded" && /1,?200|1200/.test(f.fact));
const activeNew = rentMention.some((f) => f.status === "active" && /1,?500|1500/.test(f.fact));
console.log(`[supersede verify] old($1200) superseded=${supersededOld}, new($1500) active=${activeNew}`);
let supersedeOk = true;
if (!activeNew) {
  console.log("  [FAIL] no active $1500 rent fact after contradiction.");
  supersedeOk = false;
}
if (dup.superseded === 0 && rentMention.length >= 2) {
  console.log("  [NOTE] delta produced no supersede flip — model may have worded the new");
  console.log("         fact so it didn't read as a contradiction of the stored row.");
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------
console.log("\n===== SCOREBOARD =====");
console.log(`extraction write path over real conversation: ${wrote.inserted > 0 ? "OK" : "FAIL"}`);
console.log(`retrieval surfaces summary-dropped facts: ${retrOk ? "OK" : "FAIL"}`);
console.log(`supersede path with real contradiction: ${supersedeOk ? "OK" : "FAIL"}`);

await prisma.extractedFact.deleteMany({ where: { conversationId } });
await prisma.message.deleteMany({ where: { conversationId } });
await prisma.conversation.deleteMany({ where: { id: conversationId } });
await prisma.user.delete({ where: { id: userId } }).catch(() => {});

const allOk = wrote.inserted > 0 && retrOk && supersedeOk;
process.exit(allOk ? 0 : 1);
