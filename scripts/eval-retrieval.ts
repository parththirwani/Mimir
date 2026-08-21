import { loadEnv } from "./intent-iteration/_env.js";
import {
  appendRow,
  loadFixtures,
  newRunId,
  requireDB,
  requireLiveLLM,
} from "./eval/lib.js";

// Phase 13.2 — retrieval regression gate. Drives the REAL extraction+relation
// write path and the hybrid retrieval read path over each fixture's transcript,
// then asserts the fixture's expected recall. Hard gate: recall < 90% exits
// non-zero so CI merge is blocked. In CI without a key/db it exits non-zero with
// a loud message (a skipped gate is not a pass); locally it self-skips.
//
// Run: bun eval-retrieval    (needs OPENROUTER_API_KEY + DATABASE_URL in .env)

loadEnv();
requireDB();
requireLiveLLM();

const runId = newRunId();
const { getPrismaClient } = await import("@mimir/backend-core");
const { extractFacts, searchActiveFactsWithRelations } =
  await import("../apps/worker/src/agent/fact-extraction.js");

const prisma = getPrismaClient();
const fixtures = loadFixtures();

// G8: the 90% hard-gate floor is inherited from plan §13.2.2, not derived from
// fixture baselines. With 3 fixtures × ~1 assertion each, ~90% effectively
// means "every expected fragment must surface". This is the *intended* strictness
// for a small regression gate, but is an unvalidated placeholder until real
// nightly data exists; recalibrate against measured baselines if it proves flaky
// under model variance. TODO(soft): revisit once nightly recall accumulates.
const RECALL_GATE = 0.9;

interface FixtureScore {
  fixtureId: string;
  category: string;
  expectedTotal: number;
  matched: number;
  recall: number;
  violations: string[];
}

// Seed a throwaway conversation per fixture, extract message-by-message (each
// delta = one new message, simulating the production sweep tick so relation
// edges and supersede flips form across turns), then run the held-out query.
async function runFixture(
  fx: (typeof fixtures)[number],
): Promise<FixtureScore> {
  const userId = `eval-retrieval-${runId}-${fx.id}`;
  await prisma.user.create({
    data: { id: userId, email: `${userId}@eval.local`, passwordHash: "x" },
  });
  const conv = await prisma.conversation.create({ data: { userId } });
  const conversationId = conv.id;

  const base = Date.now() - (fx.transcript.length + 1) * 60_000;
  const times = fx.transcript.map((_, i) => new Date(base + i * 60_000));
  for (let i = 0; i < fx.transcript.length; i++) {
    await prisma.message.create({
      data: {
        conversationId,
        role: fx.transcript[i]!.role,
        content: fx.transcript[i]!.content,
        createdAt: times[i]!,
      },
    });
  }

  // Extraction sweep: one message at a time (delta (from, to]).
  let from = new Date(base - 1000);
  for (const t of times) {
    await extractFacts(conversationId, from, t);
    from = t;
  }

  const hits = await searchActiveFactsWithRelations(
    conversationId,
    fx.heldOutQuery,
  );
  const norm = (s: string) =>
    s.replace(/,/g, "").replace(/\s+/g, " ").toLowerCase();
  const hitText = norm(hits.map((h) => h.fact).join("\n"));

  const expectedTotal = fx.expectedRecall.length;
  let matched = 0;
  const forbidden: string[] = [];
  for (const frag of fx.expectedRecall) {
    if (hitText.includes(norm(frag))) matched += 1;
  }
  for (const frag of fx.mustNotRecall ?? []) {
    if (hitText.includes(norm(frag))) forbidden.push(frag);
  }
  const recall = expectedTotal ? matched / expectedTotal : 0;

  for (const h of hits)
    console.log(`   - [${h.sources.join("|")}] ${h.subject}: ${h.fact}`);

  appendRow("retrieval", runId, {
    fixtureId: fx.id,
    category: fx.category,
    query: fx.heldOutQuery,
    hits: hits.map((h) => h.fact),
    matched,
    expectedTotal,
    recall: Math.round(recall * 1000) / 1000,
    forbidden,
  });

  // Cleanup scoped rows. FactRelation FK is ON DELETE RESTRICT, so relations
  // must go before the facts they point at.
  await prisma.factRelation
    .deleteMany({
      where: {
        OR: [
          { sourceFact: { conversationId } },
          { targetFact: { conversationId } },
        ],
      },
    })
    .catch(() => {});
  await prisma.extractedFact.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});

  return {
    fixtureId: fx.id,
    category: fx.category,
    expectedTotal,
    matched,
    recall,
    forbidden,
  };
}

const scores: FixtureScore[] = [];
for (const fx of fixtures) {
  console.log(`\n[${fx.id}] ${fx.title}`);
  try {
    const s = await runFixture(fx);
    scores.push(s);
    const ok = s.recall >= RECALL_GATE ? "OK" : "FAIL";
    console.log(
      `  query="${fx.heldOutQuery}" -> recall ${(s.recall * 100).toFixed(1)}% (${s.matched}/${s.expectedTotal}) ${ok}`,
    );
  } catch (e) {
    console.log(`  ERROR ${String(e)}`);
    scores.push({
      fixtureId: fx.id,
      category: fx.category,
      expectedTotal: 1,
      matched: 0,
      recall: 0,
      forbidden: [],
    });
  }
}

const totalExpected = scores.reduce((n, s) => n + s.expectedTotal, 0);
const totalMatched = scores.reduce((n, s) => n + s.matched, 0);
const overall = totalExpected ? totalMatched / totalExpected : 0;
const forbiddenHits = scores.filter((s) => s.forbidden.length > 0);

console.log("\n===== RETRIEVAL GATE =====");
console.log(
  `recall ${(overall * 100).toFixed(1)}% (${totalMatched}/${totalExpected})`,
);
for (const s of scores) {
  const flags = s.forbidden.length
    ? ` [FORBIDDEN HIT: ${s.forbidden.join(", ")}]`
    : "";
  console.log(`  ${s.fixtureId}: ${s.matched}/${s.expectedTotal}${flags}`);
}

// The hard gate is RECALL >= RECALL_GATE (spec 13.2.2). Forbidden hits (a stale,
// must-not-recall fact surfacing) are reported + persisted but do NOT block.
for (const s of forbiddenHits)
  console.log(
    `  NOTE: ${s.fixtureId} surfaced forbidden fact(s) - see issue #1 (supersede gap)`,
  );

const ok = overall >= RECALL_GATE;
console.log(ok ? "GATE PASS" : "GATE FAIL");
process.exit(ok ? 0 : 1);