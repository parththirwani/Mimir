import { FACT_EXTRACTION_TOP_K } from "./constants.js";
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