import { randomUUID } from "node:crypto";
import { loadEnv } from "./_env.js";
import { corpus } from "./corpus.js";
import {
  classifyPassed,
  finalizeReport,
  renderReport,
  writeReport,
  type ClassifyResult,
  type ClassificationAction,
  type CorpusEntry,
} from "./lib.js";

loadEnv();

// Majority-of-N sampling makes the fast loop robust to single-call LLM noise
// (a real regression fails across all samples; a stochastic flip on a boundary
// case only casts a minority vote). Default 3; override with HARNESS_SAMPLES.
const SAMPLES = Number(process.env.HARNESS_SAMPLES ?? "3");

const { classifyMessage } = await import("../../apps/api/src/agent/agent.js");
const { getPrismaClient } = await import("@mimir/backend-core");

const prisma = getPrismaClient();
const userId = `harness-classify-${randomUUID()}`;
// ModelCallLog.userId has an FK to User — create a throwaway user so telemetry
// writes don't fail (and so cleanup is a single deleteMany).
await prisma.user.create({
  data: { id: userId, email: `${userId}@harness.local`, passwordHash: "x" },
});

const KNOWN: ClassificationAction[] = ["answer_directly", "spawn_agent", "one_shot", "manage_cancel", "manage_list", "ask_clarification"];

function mapAction(a: string): ClassificationAction {
  if (KNOWN.includes(a as ClassificationAction)) return a as ClassificationAction;
  // When the classifier emits something we don't recognize, treat it as
  // answer_directly for safety (matches parseClassification fallback).
  return "answer_directly";
}

interface Sample {
  action: ClassificationAction;
  targetAgentId?: string;
  confidence: number;
  ok: boolean;
}

function sampleSatisfies(e: CorpusEntry, action: ClassificationAction): boolean {
  const probe: ClassifyResult = {
    id: e.id,
    mode: "classify",
    prompt: e.prompt,
    expected: e.expected,
    actualAction: action,
    raw: "",
    assertions: { ok: true, reasons: [] },
  };
  return classifyPassed(e, probe);
}

async function runOne(e: CorpusEntry): Promise<ClassifyResult> {
  const roster = e.roster ?? [];
  const samples: Sample[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const c = await classifyMessage(userId, e.prompt, roster);
    const action = mapAction(c.action);
    samples.push({ action, targetAgentId: c.targetAgentId, confidence: c.confidence, ok: sampleSatisfies(e, action) });
  }
  const passCount = samples.filter((s) => s.ok).length;
  const majority = passCount > SAMPLES / 2;
  // Mode/first action reported for the table.
  const counts = new Map<ClassificationAction, number>();
  for (const s of samples) counts.set(s.action, (counts.get(s.action) ?? 0) + 1);
  let actualAction: ClassificationAction = samples[0].action;
  let topCount = -1;
  for (const [a, n] of counts) {
    if (n > topCount) {
      topCount = n;
      actualAction = a;
    }
  }
  const res: ClassifyResult = {
    id: e.id,
    mode: "classify",
    prompt: e.prompt,
    expected: e.expected,
    actualAction,
    targetAgentId: samples.find((s) => s.targetAgentId)?.targetAgentId,
    confidence: Math.max(...samples.map((s) => s.confidence)),
    raw: JSON.stringify(samples.map((s) => s.action)),
    assertions: { ok: true, reasons: [] },
  };
  const reasons: string[] = [];
  if (!majority) {
    const byAction = [...counts.entries()].map(([a, n]) => `${a}(${n}/${SAMPLES})`).join(" ");
    reasons.push(`no majority over ${SAMPLES} samples [${byAction}]`);
    collectClassifyReasons(e, res).forEach((r) => reasons.push(r));
    res.assertions = { ok: false, reasons };
  } else if (passCount < SAMPLES) {
    // Passes but note the wobble (minority votes deviate).
    res.assertions = { ok: true, reasons: [`${passCount}/${SAMPLES} samples matched (minority wobble)`] };
  }
  return res;
}

function collectClassifyReasons(e: CorpusEntry, r: ClassifyResult): string[] {
  const reasons: string[] = [];
  if (e.expected.action && r.actualAction !== e.expected.action) {
    reasons.push(`action expected ${e.expected.action}, got ${r.actualAction}`);
  }
  if (e.expected.anyOf && !e.expected.anyOf.includes(r.actualAction)) {
    reasons.push(`action expected one of ${e.expected.anyOf.join("|")}, got ${r.actualAction}`);
  }
  for (const na of e.expected.notAction ?? []) {
    if (r.actualAction === na) reasons.push(`must not be ${na}`);
  }
  return reasons;
}

const entries = corpus.filter((e) => (e.mode === "classify" || e.mode === "both") && !(e.context?.length ?? 0) > 0);
const results: ClassifyResult[] = [];
for (const e of entries) {
  process.stdout.write(`  ${e.id} ${e.prompt.slice(0, 50)}... `);
  const r = await runOne(e);
  results.push(r);
  console.log(r.assertions.ok ? (r.assertions.reasons.length ? `PASS (${r.assertions.reasons[0]})` : "PASS") : `FAIL [${r.assertions.reasons.join("; ")}]`);
}

const report = finalizeReport("classify", results, entries, "classify-" + new Date().toISOString().replace(/[:.]/g, "-"));
// Recompute byId from the actual assertion results (finalizeReport uses seed matching).
report.summary.byId = {};
let passed = 0;
for (const r of results) {
  report.summary.byId[r.id] = r.assertions.ok ? "PASS" : "FAIL";
  if (r.assertions.ok) passed += 1;
}
report.summary.passed = passed;
report.summary.failed = results.length - passed;
report.summary.passRate = results.length ? Math.round((passed / results.length) * 1000) / 10 : 0;

const path = writeReport(report);
console.log("\n" + renderReport(report));
console.log(`\nWrote ${path}`);

// Child rows first (ModelCallLog/AnalyticsEvent FK to User), then the user.
await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["userId"], equals: userId } } });
await prisma.modelCallLog.deleteMany({ where: { userId } });
await prisma.analyticsEvent.deleteMany({ where: { userId } });
await prisma.user.deleteMany({ where: { id: userId } });
await prisma.$disconnect();
