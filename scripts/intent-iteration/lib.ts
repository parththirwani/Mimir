import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HarnessMode = "classify" | "e2e";

// Low-level actions the classifier may emit. The API maps these to concrete
// work (spawn -> execution agent, manage_cancel -> archive + disable triggers,
// manage_list -> list, ask_clarification -> clarify without creating state).
export type ClassificationAction =
  | "answer_directly"
  | "spawn_agent"
  | "manage_cancel"
  | "manage_list"
  | "ask_clarification";

export interface RosterAgent {
  id: string;
  taskDescription: string;
}

export interface ReplyExpectation {
  minLength?: number;
  maxLength?: number;
  exact?: string;
  mustContain?: string[];
  mustNotContain?: string[];
  // Regexes that must match (candidates like /^cancelled$/i).
  mustMatch?: RegExp[];
}

export interface Expected {
  action?: ClassificationAction;
  // API: an acceptable set of actions (any one passes) — for genuinely
  // ambiguous requests where more than one behaviour is defensible.
  anyOf?: ClassificationAction[];
  // The prompt should never be classified as these actions (e.g. a cancel
  // request must never become spawn_agent / retarget).
  notAction?: ClassificationAction[];
  // e2e: no Agent row may be created for this prompt.
  noAgent?: boolean;
  // e2e: no Trigger row may be created for this prompt.
  noTrigger?: boolean;
  // e2e: seeded roster ids (roster[*].id) that MUST have been archived to
  // `archived` status after the message (rigorous check that a cancel happened).
  archives?: string[];
  // e2e: seeded roster ids that MUST still be `active` after the message.
  notArchives?: string[];
  // The reply must satisfy these constraints (e2e mode / reply capture).
  reply?: ReplyExpectation;
  // High-level behaviour note shown in the report.
  note?: string;
}

export interface CorpusEntry {
  id: string;
  prompt: string;
  mode: HarnessMode | "both";
  // Roster seeded as "active agents" so the classifier sees existing state.
  roster?: RosterAgent[];
  // Prior conversation turns (role: content). When present, the intent-run
  // exercises the rewrite stage first (context resolution) and asserts the
  // rewritten query against expectedRewriteMatch before classifying it.
  context?: { role: string; content: string }[];
  // Substrings the rewritten query MUST contain (resolved anaphora/corrections).
  expectedRewriteMatch?: string[];
  expected: Expected;
}

export const MIMIR_STATUS_PATTERNS = {
  // Never leak internals: tool names, agent names, "interaction/execution",
  // send_message_to_agent, classification mechanics, model identity.
  leak: [
    /interaction agent/i,
    /execution agent/i,
    /send_message_to_agent/i,
    /sendmessageto_agent/i,
    /display_draft/i,
    /react_to_message/i,
    /gpt-4o/i,
    /gpt-3/i,
    /gpt-5/i,
    /openai/i,
    /deepseek/i,
    /claude/i,
    /gemini/i,
    /model-config/i,
    /classif/i,
    /\bsearch tool\b/i,
    /\bbrowser tool\b/i,
    /\bweb search\b.*\btool\b/i,
    /\btool call\b/i,
    /\bintent layer\b/i,
    /\binbox sweep\b/i,
    /\bmail.?poll\b/i,
    /\boutbox\b/i,
    /\bexecution engine\b/i,
    /\bworker\b/i,
    /\bbullmq\b/i,
    /\bredis\b/i,
    /\bpub.?sub\b/i,
    /\bAGENT_JOBS\b|\bEMAIL_JOBS\b|\bWEBHOOK_PROCESSING\b|\bFAILED_AGENT_JOBS\b|\bAGENT_TRIGGERS\b/i,
    /\bqueue\b/i,
    /\bnango\b/i,
    /\bpostgres\b/i,
    /\bprisma\b/i,
    /\bsocket\.io\b/i,
    /\bnode\.js\b/i,
    /\bbun\b/i,
    /\bchannel\b/i,
    /\bendpoint\b/i,
    /can.?t browse/i,
    /\bthis session\b/i,
    /\bno tools\b/i,
    /no web access/i,
    /can.?t look it up/i,
    /can.?t search/i,
  ],
  // Unsolicited 2026 escalation: a cancel/stop/confirm reply must not reaffirm
  // it is still watching or mention 2026 unless the prompt itself is about 2026
  // and asks for it.
  sticky2026: [/keep an eye/i, /keep watching/i, /still watching/i, /i'll watch for 2026/i, /keep an eye on that for 2026/i],
};

export interface ClassifyAssertion {
  ok: boolean;
  reasons: string[];
}

export interface E2eAssertion {
  ok: boolean;
  reasons: string[];
}

export interface ClassifyResult {
  id: string;
  mode: "classify";
  prompt: string;
  expected: Expected;
  actualAction: ClassificationAction;
  targetAgentId?: string;
  confidence: number;
  assertions: ClassifyAssertion;
  raw: string;
}

export interface E2eResult {
  id: string;
  mode: "e2e";
  prompt: string;
  expected: Expected;
  reply: string;
  agentCreated: boolean;
  triggerCreated: boolean;
  outbox: string[];
  // archiveState: seeded roster id -> status after the message. Lets tests
  // assert a cancel REALLY archived a watch (not merely "no new agent").
  archiveState: Record<string, string>;
  assertions: E2eAssertion;
}

export type HarnessResult = ClassifyResult | E2eResult;

export interface Report {
  mode: HarnessMode;
  runId: string;
  startedAt: string;
  results: HarnessResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    byId: Record<string, "PASS" | "FAIL">;
    categories: Record<string, { total: number; passed: number }>;
  };
}

const categoryOf = (id: string): string => {
  const suite = id.replace(/[0-9]+$/, "");
  return suite || "other";
};

export function classifyPassed(e: CorpusEntry, c: ClassifyResult): boolean {
  const reasons: string[] = [];
  const exp = e.expected;
  let ok = true;
  if (exp.action && c.actualAction !== exp.action) {
    ok = false;
    reasons.push(`action expected ${exp.action}, got ${c.actualAction}`);
  }
  if (exp.anyOf && !exp.anyOf.includes(c.actualAction)) {
    ok = false;
    reasons.push(`action expected one of ${exp.anyOf.join("|")}, got ${c.actualAction}`);
  }
  for (const na of exp.notAction ?? []) {
    if (c.actualAction === na) {
      ok = false;
      reasons.push(`must not be ${na}`);
    }
  }
  if (exp.action === "manage_cancel") {
    // A cancel must never carry a target that causes a retarget/spawn.
    if (c.actualAction === "spawn_agent" && c.targetAgentId) {
      ok = false;
      reasons.push("cancel classified as spawn_agent with targetAgentId (retarget leak)");
    }
  }
  // Sanity: action must be one of the known set (guards against parse drift).
  if (!["answer_directly", "spawn_agent", "manage_cancel", "manage_list", "ask_clarification"].includes(c.actualAction)) {
    ok = false;
    reasons.push(`unknown action ${c.actualAction}`);
  }
  return ok && reasons.length === 0 ? true : false;
}

export function e2ePassed(e: CorpusEntry, r: E2eResult): boolean {
  const reasons: string[] = [];
  const exp = e.expected;
  let ok = true;

  const reply = r.reply;
  if (exp.reply?.exact !== undefined && reply.trim() !== exp.reply.exact) {
    ok = false;
    reasons.push(`reply not exact: expected "${exp.reply.exact}" got "${reply.trim()}"`);
  }
  if (exp.reply?.minLength !== undefined && reply.length < exp.reply.minLength) {
    ok = false;
    reasons.push(`reply too short (<${exp.reply.minLength})`);
  }
  if (exp.reply?.maxLength !== undefined && reply.length > exp.reply.maxLength) {
    ok = false;
    reasons.push(`reply too long (>${exp.reply.maxLength})`);
  }
  for (const m of exp.reply?.mustContain ?? []) {
    if (!reply.toLowerCase().includes(m.toLowerCase())) {
      ok = false;
      reasons.push(`reply missing "${m}"`);
    }
  }
  for (const n of exp.reply?.mustNotContain ?? []) {
    if (reply.toLowerCase().includes(n.toLowerCase())) {
      ok = false;
      reasons.push(`reply must not contain "${n}"`);
    }
  }
  for (const rre of exp.reply?.mustMatch ?? []) {
    if (!rre.test(reply)) {
      ok = false;
      reasons.push(`reply does not match ${rre}`);
    }
  }
  if (exp.noAgent && r.agentCreated) {
    ok = false;
    reasons.push("an Agent row was created but none was expected");
  }
  if (exp.noTrigger && r.triggerCreated) {
    ok = false;
    reasons.push("a Trigger row was created but none was expected");
  }
  for (const id of exp.archives ?? []) {
    if (r.archiveState[id] !== "archived") {
      ok = false;
      reasons.push(`expected ${id} to be archived, got ${r.archiveState[id] ?? "missing"}`);
    }
  }
  for (const id of exp.notArchives ?? []) {
    if (r.archiveState[id] === "archived") {
      ok = false;
      reasons.push(`expected ${id} to stay active, but it was archived`);
    }
  }
  return ok && reasons.length === 0 ? true : false;
}

export function finalizeReport(mode: HarnessMode, results: HarnessResult[], seed: CorpusEntry[], runId: string): Report {
  const byId: Record<string, "PASS" | "FAIL"> = {};
  const categories: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  for (const res of results) {
    const seedEntry = seed.find((s) => s.id === res.id)!;
    const ok = res.mode === "classify" ? classifyPassed(seedEntry, res as ClassifyResult) : e2ePassed(seedEntry, res as E2eResult);
    byId[res.id] = ok ? "PASS" : "FAIL";
    if (ok) passed += 1;
    const cat = categoryOf(res.id);
    categories[cat] ??= { total: 0, passed: 0 };
    categories[cat].total += 1;
    if (ok) categories[cat].passed += 1;
  }
  return {
    mode,
    runId,
    startedAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
      byId,
      categories,
    },
  };
}

export function writeReport(report: Report): string {
  const dir = join(process.cwd(), "scripts", "intent-iteration", "results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "latest.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Intent-iteration report (${report.mode}) run=${report.runId}`);
  lines.push(`Pass rate: ${report.summary.passRate}%  (${report.summary.passed}/${report.summary.total})`);
  lines.push("");
  const catKeys = Object.keys(report.summary.categories).sort();
  for (const cat of catKeys) {
    const c = report.summary.categories[cat] ?? { total: 0, passed: 0 };
    lines.push(`  ${cat}: ${c.passed}/${c.total}`);
  }
  lines.push("");
  lines.push(`id | mode | prompt | expectedAct | actualAct | RESULT | violations`);
  lines.push("---|---|---|---|---|---|---");
  for (const res of report.results) {
    const ok = res.mode === "classify"
      ? (res as ClassifyResult).assertions.ok
      : (res as E2eResult).assertions.ok;
    const violations = res.mode === "classify"
      ? (res as ClassifyResult).assertions.reasons.join("; ")
      : (res as E2eResult).assertions.reasons.join("; ");
    const expectedAct = res.expected.action ?? "-";
    const actualAct = res.mode === "classify"
      ? `${(res as ClassifyResult).actualAction}${(res as ClassifyResult).targetAgentId ? " @" + (res as ClassifyResult).targetAgentId : ""}`
      : "(reply)";
    lines.push(`${res.id} | ${res.mode} | ${res.prompt.slice(0, 60)} | ${expectedAct} | ${actualAct} | ${ok ? "PASS" : "FAIL"} | ${violations}`);
  }
  return lines.join("\n");
}
