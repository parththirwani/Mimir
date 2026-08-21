import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Shared helpers for the Phase 13 eval harness. Scripts run from the repo root
// (bun eval-retrieval) and load .env via loadEnv() before any backend-core import
// (whose config validates env at import time).

export interface FixtureMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Fixture {
  id: string;
  category: string;
  title: string;
  description?: string;
  transcript: FixtureMessage[];
  heldOutQuery: string;
  expectedRecall: string[];
  mustNotRecall?: string[];
}

export function loadFixtures(): Fixture[] {
  const dir = join(process.cwd(), "fixtures");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const out: Fixture[] = [];
  for (const f of files) {
    const fixture = JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture;
    if (!fixture.id || !Array.isArray(fixture.transcript) || !Array.isArray(fixture.expectedRecall)) {
      throw new Error(`fixture ${f} missing id/transcript/expectedRecall`);
    }
    out.push(fixture);
  }
  if (out.length === 0) throw new Error("no fixtures found in fixtures/");
  return out;
}

// One runId per invocation; every JSON row carries it so a proposal's
// evidenceRunIds can cite the concrete runs behind a tuning decision.
export const newRunId = (): string => randomUUID();

// CI affordance (gap G5): a missing API key must NOT read as a passing gate in
// CI. Locally it is a clean, visible skip.
export function isCI(): boolean {
  return process.env.CI === "true" || process.env.CI === "1" || process.env.GITHUB_ACTIONS === "true";
}

export function requireLiveLLM(): void {
  if (!process.env.OPENROUTER_API_KEY) {
    const msg = "OPENROUTER_API_KEY missing";
    if (isCI()) {
      console.log(`GATE NOT RUN: ${msg}`);
      process.exit(2);
    }
    console.log(`SKIPPED (${msg})`);
    process.exit(0);
  }
}

export function requireDB(): void {
  if (!process.env.DATABASE_URL) {
    const msg = "DATABASE_URL missing";
    if (isCI()) {
      console.log(`GATE NOT RUN: ${msg}`);
      process.exit(2);
    }
    console.log(`SKIPPED (${msg})`);
    process.exit(0);
  }
}

export function appendRow(kind: string, runId: string, row: Record<string, unknown>): string {
  const dir = join(process.cwd(), "results", "eval-runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${kind}.jsonl`);
  appendFileSync(path, JSON.stringify({ runId, ts: new Date().toISOString(), ...row }) + "\n");
  return path;
}