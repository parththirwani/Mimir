import { FACT_EXTRACTION_TOP_K, FACT_INJECT_CAP, FACT_RRF_K } from "./constants.js";
import { getLogger } from "./logger.js";
import { callEmbeddings } from "./openrouter.js";
import { getPrismaClient } from "./prisma.js";

// Lives in backend-core (not the worker) so the api can inject retrieved facts
// into the chat reply context. The write path (extractFacts/deleteFact) stays
// worker-only in apps/worker/src/agent/fact-extraction.ts.

const prisma = getPrismaClient();

export interface FactHit {
  id: string;
  subject: string;
  fact: string;
  similarity: number;
}

// Top-K embedding search over ACTIVE facts for a conversation. The WHERE clause
// filters `status = 'active'` EXPLICITLY — superseded AND deleted facts are
// excluded by construction, never by accident. Fail-open: embed error -> empty
// list (nothing injected), mirroring the roster-search behavior.
export async function searchActiveFacts(
  conversationId: string,
  query: string,
  deps: { embed?: (text: string) => Promise<number[]>; topK?: number } = {},
): Promise<FactHit[]> {
  const topK = deps.topK ?? FACT_EXTRACTION_TOP_K;
  const embed = deps.embed ?? callEmbeddings;
  if (!query.trim()) return [];

  let vec: number[];
  try {
    vec = await embed(query);
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact search embed failed; injecting nothing (fail-open)");
    return [];
  }
  if (vec.length === 0) return [];
  const vecLiteral = `[${vec.join(",")}]`;

  try {
    const rows = await prisma.$queryRaw<FactHit[]>`
      SELECT id, subject, fact, 1 - (embedding <=> ${vecLiteral}::vector) AS similarity
      FROM "ExtractedFact"
      WHERE status = 'active' AND "conversationId" = ${conversationId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT ${topK}
    `;
    return rows;
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact search query failed; injecting nothing (fail-open)");
    return [];
  }
}

// Reciprocal Rank Fusion: score(doc) = sum over ranked lists of 1/(K + rank).
// K damps low ranks so one cheap rank doesn't dominate the fused score.
function rrfFuse(lists: string[][], k: number, topN: number): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([id]) => id);
}

// Hybrid retrieval: pgvector top-K and ts_rank full-text in parallel, merged via
// RRF, then each hit expanded through FactRelation (both directions), capping
// injected facts at FACT_INJECT_CAP. Each side fails open independently:
// vector down -> lexical only, and vice versa.
export async function searchActiveFactsWithRelations(
  conversationId: string,
  query: string,
  deps: { embed?: (text: string) => Promise<number[]>; topK?: number } = {},
): Promise<FactHit[]> {
  const topK = deps.topK ?? FACT_EXTRACTION_TOP_K;
  const embed = deps.embed ?? callEmbeddings;
  if (!query.trim()) return [];

  const vectorIds: string[] = [];
  try {
    const vec = await embed(query);
    if (vec.length > 0) {
      const vecLiteral = `[${vec.join(",")}]`;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "ExtractedFact"
        WHERE status = 'active' AND "conversationId" = ${conversationId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vecLiteral}::vector
        LIMIT ${topK}`;
      vectorIds.push(...rows.map((r) => r.id));
    }
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact vector side failed; lexical-only (fail-open)");
  }

  let lexicalIds: string[] = [];
  try {
    // OR the query terms into a tsquery (`websearch_to_tsquery` ANDs, which
    // falses on a phrase where one short word is absent — "how much rent" would
    // match nothing). Splitting free-text into OR-ed terms makes a short user
    // query match on ANY present word.
    const terms = query.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    if (terms.length === 0) throw new Error("no lexical terms");
    const tsq = terms.join(" | ");
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ExtractedFact"
      WHERE status = 'active' AND "conversationId" = ${conversationId}
        AND to_tsquery('english', ${tsq}) @@ "factSearch"
      ORDER BY ts_rank("factSearch", to_tsquery('english', ${tsq}))
      LIMIT ${topK}`;
    lexicalIds = rows.map((r) => r.id);
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact lexical side failed; vector-only (fail-open)");
  }

  const top = rrfFuse([vectorIds, lexicalIds], FACT_RRF_K, topK);
  if (top.length === 0) return [];

  let rows: { id: string; subject: string; fact: string }[];
  try {
    rows = await prisma.extractedFact.findMany({
      where: { id: { in: top } },
      select: { id: true, subject: true, fact: true },
    });
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "fact fetch after fusion failed (fail-open)");
    return [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));

  try {
    const rel = await prisma.factRelation.findMany({
      where: { OR: [{ sourceFactId: { in: top } }, { targetFactId: { in: top } }] },
      select: { sourceFactId: true, targetFactId: true },
    });
    const ranked = new Set(top);
    const neighborIds: string[] = [];
    for (const r of rel) {
      const consider = (id: string) => {
        if (!ranked.has(id) && !neighborIds.includes(id)) neighborIds.push(id);
      };
      consider(r.sourceFactId);
      consider(r.targetFactId);
    }
    if (neighborIds.length > 0) {
      const nb = await prisma.extractedFact.findMany({
        where: { id: { in: neighborIds }, status: "active" },
        select: { id: true, subject: true, fact: true },
      });
      for (const n of nb) if (!byId.has(n.id)) byId.set(n.id, n);
    }
  } catch (e) {
    getLogger().warn({ err: e, conversationId }, "relation expansion failed (top-K only)");
  }

  // ranked hits first (fused order), then relation neighbors; cap the total.
  const out: FactHit[] = [];
  const seen = new Set<string>();
  const push = (f: { id: string; subject: string; fact: string }) => {
    if (out.length === FACT_INJECT_CAP || seen.has(f.id)) return;
    seen.add(f.id);
    out.push({ id: f.id, subject: f.subject, fact: f.fact, similarity: 0 });
  };
  for (const f of rows) push(f);
  const ranked = new Set(rows.map((r) => r.id));
  for (const f of byId.values()) if (!ranked.has(f.id)) push(f);
  return out;
}