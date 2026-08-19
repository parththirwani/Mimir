import {
  FACT_NEAR_THRESHOLD,
  getLogger,
  getPrismaClient,
  loadPrompt,
  callOpenRouter,
  callEmbeddings,
  trackModelCall,
} from "@mimir/backend-core";
import type { ChatResult, LlmMessage } from "@mimir/shared-types";

// Phase 10 fact layer — flat, atomically-retrievable durable facts extracted
// from the thread, alongside the narrative ConversationSummary. Extraction is a
// fixed pipeline (NOT agent-managed memory): run on the same sweep tick as
// summarization over the same delta message range, then stored for retrieval.
//
// The READ path (searchActiveFacts / FactHit) lives in packages/backend-core
// (shared with the api's reply-context injection) and is re-exported here so
// this module remains the single import surface for callers/tests.
//
// ponytail: compat re-export, delete when scripts/phase10-facts/run.ts and
// __tests__/fact-extraction.test.ts import from @mimir/backend-core directly.
export { searchActiveFacts, type FactHit } from "@mimir/backend-core";

const prisma = getPrismaClient();

export type LlmCaller = (messages: LlmMessage[], options?: { useCase?: string }) => Promise<ChatResult>;

export interface ExtractedFactInput {
  subject: string;
  fact: string;
}

export interface FactCandidate {
  subject: string;
  fact: string;
  sourceMessageId?: string;
}

// Fact statuses. `status` is a plain string in the DB (see schema comment: keeps
// gaining states without ALTER TYPE); this TS union is the single source of the
// allowed set at call sites.
export type FactStatus = "active" | "superseded" | "deleted";

// Deletion reasons. Short, canonical set; stored as free string so a future
// caller can extend without a migration.
export type FactDeleteReason = "incorrect_extraction" | "user_requested" | "manual_correction";

const EXTRACT_SYSTEM = loadPrompt("extract_facts.md");
const CONFLICT_SYSTEM = loadPrompt("fact_conflict.md");

// ---------------------------------------------------------------------------
// Parsing (fail-open: unparseable -> empty list, never a throw)
// ---------------------------------------------------------------------------

export function parseExtractedFacts(raw: string): ExtractedFactInput[] {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned) as { facts?: unknown };
    if (!Array.isArray(json.facts)) return [];
    const out: ExtractedFactInput[] = [];
    for (const f of json.facts) {
      if (typeof f !== "object" || f === null) continue;
      const s = f as Record<string, unknown>;
      if (typeof s.subject !== "string" || !s.subject.trim()) continue;
      if (typeof s.fact !== "string" || !s.fact.trim()) continue;
      out.push({ subject: s.subject.trim(), fact: s.fact.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

// Parse {supersede:[bool,...]}. Fail-open: any error -> all false (no-touch).
export function parseConflictVerdict(raw: string, count: number): boolean[] {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const json = JSON.parse(cleaned) as { supersede?: unknown };
    if (!Array.isArray(json.supersede)) return Array(count).fill(false);
    const arr = json.supersede as unknown[];
    return Array.from({ length: count }, (_, i) => arr[i] === true);
  } catch {
    return Array(count).fill(false);
  }
}

// ---------------------------------------------------------------------------
// Write path — extractFacts
// ---------------------------------------------------------------------------
//
// Runs on the schedule sweep over the SAME delta range
// (from, to] so neither re-reads the whole thread. Fail-open: extraction must
// never block the summary write or the sweep — all failures here are caught,
// logged, and skipped.

interface ExtractDeps {
  caller?: LlmCaller;
  embed?: (text: string) => Promise<number[]>;
}

async function embedVector(embed: (text: string) => Promise<number[]>, text: string): Promise<number[] | null> {
  try {
    const v = await embed(text);
    return v.length > 0 ? v : null;
  } catch (e) {
    getLogger().warn({ err: e }, "fact embedding failed (skip)");
    return null;
  }
}

// Contradiction judge over a batch of candidate (existingActive, newFact) pairs,
// one cheap LLM call instead of one per pair.
async function judgeContradictions(
  pairs: Array<{ existing: { id: string; subject: string; fact: string }; fresh: ExtractedFactInput }>,
  userId: string,
  caller: LlmCaller,
): Promise<Set<number>> {
  if (pairs.length === 0) return new Set();
  const render = pairs
    .map((p, i) => `${i}. existing="${p.existing.fact}" new="${p.fresh.fact}"`)
    .join("\n");
  const messages: LlmMessage[] = [
    { role: "system", content: CONFLICT_SYSTEM },
    { role: "user", content: render },
  ];
  let result: ChatResult;
  try {
    result = await caller(messages, { useCase: "fact_conflict" });
  } catch (e) {
    getLogger().warn({ err: e }, "fact conflict judge failed; keeping both active (fail-open)");
    await trackModelCall({ userId, useCase: "fact_conflict", error: (e as Error)?.message ?? String(e) });
    return new Set();
  }
  await trackModelCall({ userId, useCase: "fact_conflict", result });
  const verdicts = parseConflictVerdict(result.content, pairs.length);
  return new Set(verdicts.map((v, i) => (v ? i : -1)).filter((i) => i >= 0));
}

export async function extractFacts(
  conversationId: string,
  from: Date,
  to: Date,
  deps: ExtractDeps = {},
): Promise<{ inserted: number; superseded: number }> {
  const caller = deps.caller ?? callOpenRouter;
  const embed = deps.embed ?? callEmbeddings;

  let conversation;
  try {
    conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  } catch (e) {
    getLogger().error({ err: e, conversationId }, "extractFacts: conversation lookup failed");
    return { inserted: 0, superseded: 0 };
  }
  if (!conversation) {
    getLogger().warn({ conversationId }, "extractFacts: conversation not found");
    return { inserted: 0, superseded: 0 };
  }
  const userId = conversation.userId;

  // Load the delta message range.
  let raw;
  try {
    raw = await prisma.message.findMany({
      where: { conversationId, createdAt: { gt: from, lte: to } },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true },
    });
  } catch (e) {
    getLogger().error({ err: e, conversationId }, "extractFacts: message load failed");
    return { inserted: 0, superseded: 0 };
  }
  if (raw.length === 0) return { inserted: 0, superseded: 0 };

  const text = raw.map((m) => `[${m.role}] ${m.content}`).join("\n");

  // LLM extraction.
  let extracted: ChatResult;
  try {
    extracted = await caller(
      [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: text }],
      { useCase: "fact_extraction" },
    );
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact extraction LLM failed; skip (fail-open)");
    await trackModelCall({ userId, useCase: "fact_extraction", error: (e as Error)?.message ?? String(e) });
    return { inserted: 0, superseded: 0 };
  }
  await trackModelCall({ userId, useCase: "fact_extraction", result: extracted });

  const facts = parseExtractedFacts(extracted.content);
  if (facts.length === 0) return { inserted: 0, superseded: 0 };

  let inserted = 0;
  let superseded = 0;

  // Supersede pass, batched: for each new fact, embed it + find its nearest
  // ACTIVE existing fact on the SAME subject; collect candidate pairs, then run
  // ONE conflict judge call over the whole batch (one cheap LLM call, not one
  // per fact). Only close matches (>= FACT_NEAR_THRESHOLD) enter the judge —
  // below that, given the same subject, they're treated as unrelated and both
  // stay active without spending a judge call.
  const pairs: Array<{ existing: { id: string; subject: string; fact: string }; fresh: ExtractedFactInput; freshIndex: number }> = [];
  const embs: (number[] | null)[] = new Array(facts.length).fill(null);

  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    const vec = await embedVector(embed, f.fact);
    embs[i] = vec;
    if (!vec) continue; // fail-open: no embedding -> still insert without supersede link
    const vecLiteral = `[${vec.join(",")}]`;

    let existing: { id: string; subject: string; fact: string; similarity: number } | null = null;
    try {
      const rows = await prisma.$queryRaw<
        { id: string; subject: string; fact: string; similarity: number }[]
      >`SELECT id, subject, fact, 1 - (embedding <=> ${vecLiteral}::vector) AS similarity
         FROM "ExtractedFact"
         WHERE status = 'active' AND "conversationId" = ${conversationId} AND subject = ${f.subject} AND embedding IS NOT NULL
         ORDER BY embedding <=> ${vecLiteral}::vector
         LIMIT 1`;
      existing = rows[0] ?? null;
    } catch (e) {
      getLogger().warn({ err: e, conversationId }, "fact nearest-neighbor query failed (insert without supersede)");
    }

    if (existing && existing.similarity >= FACT_NEAR_THRESHOLD) {
      pairs.push({ existing, fresh: f, freshIndex: i });
    }
  }

  const toSupersede = await judgeContradictions(
    pairs.map((p) => ({ existing: p.existing, fresh: p.fresh })),
    userId,
    caller,
  );
  const supersedeByFreshIndex = new Map<number, string>();
  for (const p of pairs) {
    if (toSupersede.has(p.freshIndex)) supersedeByFreshIndex.set(p.freshIndex, p.existing.id);
  }

  // Insert facts (with embeds + supersede links) and flip superseded rows.
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    const vec = embs[i];
    const supersedesExisting = supersedeByFreshIndex.get(i);

    let newId: string | null = null;
    try {
      const created = await prisma.extractedFact.create({
        data: {
          conversationId,
          userId,
          subject: f.subject,
          fact: f.fact,
          status: "active",
          sourceMessageId: raw[0]?.id,
          ...(supersedesExisting ? { supersedesId: supersedesExisting } : {}),
        },
        select: { id: true },
      });
      newId = created.id;
    } catch (e) {
      getLogger().error({ err: e, conversationId, subject: f.subject }, "fact insert failed (skip)");
      continue;
    }

    if (vec && newId) {
      try {
        await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${`[${vec.join(",")}]`}::vector WHERE id = ${newId}`;
      } catch (e) {
        getLogger().warn({ err: e, factId: newId }, "fact embedding write failed (fact kept, no embed)");
      }
    }

    if (supersedesExisting) {
      // The old active fact is superseded by the new one: flip it to
      // "superseded" (preserved for history, excluded from reads). The new row
      // carries supersedesId -> old row. We never clear the old row's own
      // supersedesId — an older chain link before it stays as historical metadata.
      try {
        await prisma.extractedFact.updateMany({
          where: { id: supersedesExisting, status: "active" },
          data: { status: "superseded" },
        });
      } catch (e) {
        getLogger().error({ err: e, factId: supersedesExisting }, "supersede flip failed (new fact kept, old stays active)");
      }
      superseded += 1;
    }
    inserted += 1;
  }

  return { inserted, superseded };
}

// ---------------------------------------------------------------------------
// Delete path — deleteFact
// ---------------------------------------------------------------------------
//
// Soft delete: status flip only, row kept for audit. Idempotent — missing or
// already-deleted ids are a no-op (0 rows updated), never a throw. This is a
// SEPARATE operation from supersede: supersede says "this fact changed",
// delete says "this fact should never have been stored". Chain notes:
// deleting the OLD fact that a newer fact supersedes does NOT touch the newer
// fact (independent row) — only the chain pointer (old.supersedesId is null;
// the newer.supersedesId points at the now-deleted old row, which stays valid
// since the row still exists).
//
// ponytail: deleteFact has ZERO production call sites today, deliberately — no
// confidence signal exists in the extraction pipeline and no "forget this"
// UI/API exists yet. It ships ready-to-call so a real trigger (incorrect
// extraction flag, a user-facing forget action) wires here without changing
// semantics. Add call sites only when a real trigger exists; don't invent
// speculative wiring or a confidence model to call it.
export async function deleteFact(factId: string, reason: FactDeleteReason): Promise<void> {
  try {
    await prisma.extractedFact.updateMany({
      where: { id: factId, status: { not: "deleted" } },
      data: { status: "deleted", deletedAt: new Date(), deletedReason: reason },
    });
  } catch (e) {
    getLogger().error({ err: e, factId, reason }, "deleteFact failed (no-op)");
  }
}
