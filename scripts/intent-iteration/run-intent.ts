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

const SAMPLES = Number(process.env.HARNESS_SAMPLES ?? "3");

const { rewriteQuery, classifyMessage } = await import("../../apps/api/src/agent/agent.js");
const { getPrismaClient } = await import("@mimir/backend-core");

const prisma = getPrismaClient();
const userId = `harness-intent-${randomUUID()}`;
await prisma.user.create({ data: { id: userId, email: `${userId}@harness.local`, passwordHash: "x" } });

const KNOWN: ClassificationAction[] = ["answer_directly", "spawn_agent", "one_shot", "manage_cancel", "manage_list", "ask_clarification"];
function mapAction(a: string): ClassificationAction {
  if (KNOWN.includes(a as ClassificationAction)) return a as ClassificationAction;
  return "answer_directly";
}

async function runOne(e: CorpusEntry): Promise<ClassifyResult> {
  const roster = e.roster ?? [];
  const reasons: string[] = [];

  // Stage 1 — rewrite (context resolution).
  const rewritten = await rewriteQuery(userId, e.context ?? [], e.prompt);
  const rewriteOk = (e.expectedRewriteMatch ?? []).every((m) => rewritten.toLowerCase().includes(m.toLowerCase()));
  if (e.expectedRewriteMatch && !rewriteOk) {
    reasons.push(`rewrite missing [${(e.expectedRewriteMatch ?? []).filter((m) => !rewritten.toLowerCase().includes(m.toLowerCase())).join("|")}] -> got: "${rewritten}"`);
  }

  // Stage 2 — classify the rewritten query (majority-of-N).
  const samples: string[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const c = await classifyMessage(userId, rewritten, roster);
    samples.push(mapAction(c.action));
  }
  const counts = new Map<ClassificationAction, number>();
  for (const a of samples) counts.set(a, (counts.get(a) ?? 0) + 1);
  let actualAction: ClassificationAction = mapAction(samples[0]);
  let top = -1;
  for (const [a, n] of counts) if (n > top) { top = n; actualAction = a; }
  const probe: ClassifyResult = {
    id: e.id,
    mode: "classify",
    prompt: e.prompt,
    expected: e.expected,
    actualAction,
    raw: rewritten,
    assertions: { ok: true, reasons: [] },
  };
  if (!classifyPassed(e, probe)) {
    if (e.expected.action && actualAction !== e.expected.action) reasons.push(`action expected ${e.expected.action}, got ${actualAction}`);
    for (const na of e.expected.notAction ?? []) if (actualAction === na) reasons.push(`must not be ${na}`);
    if (e.expected.anyOf && !e.expected.anyOf.includes(actualAction)) reasons.push(`action not in ${e.expected.anyOf.join("|")}`);
  }

  return {
    id: e.id,
    mode: "classify",
    prompt: `${e.prompt}${e.context?.length ? `  [ctx=${e.context.length} turns]` : ""}`,
    expected: e.expected,
    actualAction,
    confidence: 0,
    raw: rewritten,
    assertions: { ok: reasons.length === 0, reasons },
  };
}

const entries = corpus.filter((e) => (e.expectedRewriteMatch?.length ?? 0) > 0 || (e.context?.length ?? 0) > 0);
const results: ClassifyResult[] = [];
for (const e of entries) {
  process.stdout.write(`  ${e.id} ${e.prompt.slice(0, 50)}... `);
  const r = await runOne(e);
  results.push(r);
  console.log(r.assertions.ok ? "PASS" : `FAIL [${r.assertions.reasons.join("; ")}]`);
  console.log(`      rewritten: ${r.raw}`);
}

const report = finalizeReport("intent", results, entries, "intent-" + new Date().toISOString().replace(/[:.]/g, "-"));
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

await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["userId"], equals: userId } } });
await prisma.modelCallLog.deleteMany({ where: { userId } });
await prisma.analyticsEvent.deleteMany({ where: { userId } });
await prisma.user.deleteMany({ where: { id: userId } });
await prisma.$disconnect();
