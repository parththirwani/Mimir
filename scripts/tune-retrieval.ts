import { loadEnv } from "./intent-iteration/_env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 13.5 — feedback-driven retrieval tuning. Aggregates recent eval-run
// JSONL into bounded, human-gated tuning proposals (pending rows in
// RetrievalTuningProposal). NOT applied automatically; a human reviews, rejects,
// or runs the apply step (see scripts/eval/apply-proposal.ts).
//
// === What this reads (G7) ===
// Reads BOTH files in results/eval-runs/ (last 120 rows each):
//   - retrieval.jsonl  rows have `category` + numeric `recall` (per fixture).
//   - query.jsonl      rows have `category` + boolean `usedExpectedFact` / `hallucinated`.
// The two are NOT joined by runId. Instead they reconcile per fixture CATEGORY:
// each map entry holds one category's recall[] (from retrieval.jsonl) and
// usedExpected[]/hallucinated[] (from query.jsonl). Proposals are generated from
// RECALL ALONE (recall-only tuning), while judge booleans act as a veto guardrail
// only. This asymmetry is INTENTIONAL: the proposal (a retrieval-param change to
// top-K) is grounded in the same measurement it tunes, and judge output is too
// noisy (see G10) to drive a proposal on its own. evidenceRunIds cites the union
// of recent run ids that informed the category.
//
// Run: bun tune-retrieval    (needs DATABASE_URL)

loadEnv();
if (!process.env.DATABASE_URL) {
  const missing = "DATABASE_URL missing";
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    console.log(`GATE NOT RUN: ${missing}`);
    process.exit(2);
  }
  console.log(`SKIPPED (${missing})`);
  process.exit(0);
}

const { getPrismaClient } = await import("@mimir/backend-core");
const prisma = getPrismaClient();

const RUNS_DIR = join(process.cwd(), "results", "eval-runs");

function lastRows(kind: string, n: number): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(RUNS_DIR, `${kind}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .slice(-n);
  } catch {
    return [];
  }
}

function avg(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : NaN;
}

const retrieval = lastRows("retrieval", 120);
const query = lastRows("query", 120);
if (retrieval.length === 0) {
  console.log("no retrieval.jsonl rows yet — run eval-retrieval nightly to accumulate evidence");
  process.exit(0);
}

const byFixture = new Map<string, { recall: number[]; usedExpected: number[]; hallucinated: number[] }>();
for (const r of retrieval) {
  const k = String(r.category);
  const e = byFixture.get(k) ?? { recall: [], usedExpected: [], hallucinated: [] };
  const rec = Number(r.recall);
  if (Number.isFinite(rec)) e.recall.push(rec);
  byFixture.set(k, e);
}
for (const q of query) {
  const k = String(q.category);
  const e = byFixture.get(k) ?? { recall: [], usedExpected: [], hallucinated: [] };
  if (typeof q.usedExpectedFact === "boolean") e.usedExpected.push(q.usedExpectedFact ? 1 : 0);
  if (typeof q.hallucinated === "boolean") e.hallucinated.push(q.hallucinated ? 1 : 0);
  byFixture.set(k, e);
}

interface Proposal {
  param: string;
  oldValue: number;
  newValue: number;
  evidenceRunIds: string[];
  rationale: string;
}

let proposals: Proposal[] = [];
const runIds = Array.from(new Set([...retrieval, ...query].map((r) => String(r.runId))));

for (const [cat, s] of byFixture) {
  const recall = avg(s.recall);
  if (!Number.isFinite(recall)) continue;
  // 13.5.2 bounded top-K: only SHRINK top-K, only when recall is comfortably met.
  if (recall >= 0.95) {
    proposals.push({
      param: `${cat}.topK`,
      oldValue: 5,
      newValue: 4,
      evidenceRunIds: runIds,
      rationale: `${cat} recall ${(recall * 100).toFixed(1)}% is consistently met in the top-K window; lowering top-K cuts injection tokens + latency.`,
    });
  }
  // Guardrail: if judge evidence is weak, veto the shrink.
  if (s.usedExpected.length >= 2 && avg(s.usedExpected) < 0.85) {
    proposals = proposals.filter((p) => p.param !== `${cat}.topK`);
    console.log(`  [guardrail] ${cat}: judge usedExpected ${avg(s.usedExpected).toFixed(2)} — no ${cat}.topK proposal`);
  }
}

for (const p of proposals) {
  const existing = await prisma.retrievalTuningProposal.findFirst({
    where: { param: p.param, status: "pending" },
  });
  if (existing) {
    console.log(`skip ${p.param}: already has pending proposal ${existing.id}`);
    continue;
  }
  const row = await prisma.retrievalTuningProposal.create({
    data: {
      param: p.param,
      oldValue: p.oldValue,
      newValue: p.newValue,
      evidenceRunIds: p.evidenceRunIds,
      rationale: p.rationale,
    },
  });
  console.log(`proposed ${p.param}: ${p.oldValue} -> ${p.newValue} (${row.id})`);
}

process.exit(0);