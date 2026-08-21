import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ChatResult, LlmMessage } from "@mimir/shared-types";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "fact-extraction-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { deleteFact, extractFacts, searchActiveFacts, searchActiveFactsWithRelations, parseExtractedFacts, parseFactRelations } = await import("../agent/fact-extraction.js");

const prisma = getPrismaClient();

const userId = `fact-test-${randomUUID()}`;
let conversationId = "";
const DIM = 1536;

// A fixed, non-zero 1536-dim vector. Tests that need SIMILARITY control insert
// rows directly with explicit vectors; extraction-path tests use this constant
// embed so any two same-subject facts land at similarity ~1.0 (the candidate
// gate passes) and the CONFLICT JUDGE decides supersede vs not.
const FIXED_VEC = Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 0.8 : 0.2));

// One-hot-ish vector with a single strong component at `idx` — gives clean,
// controllable cosine ordering for retrieval tests.
const vec = (idx: number): number[] => Array.from({ length: DIM }, (_, i) => (i === idx ? 1 : 0));
const vecLiteral = (v: number[]) => `[${v.join(",")}]`;

// Fake LLM caller: a mutable mock. Reads `mock.extract` for fact_extraction
// responses and `mock.judge` for fact_conflict responses.
const mock: {
  extract: () => string;
  relations: () => string;
  judge: () => string;
  throwOnExtract?: boolean;
} = {
  extract: () => '{"facts":[]}',
  relations: () => '{"relations":[]}',
  judge: () => '{"supersede":[false]}',
};

const baseUsage = { totalTokens: 1, promptTokens: 1, completionTokens: 0 };
const chat = (content: string): ChatResult => ({ content, model: "m", latencyMs: 1, usage: baseUsage });

async function fakeCaller(messages: LlmMessage[], options?: { useCase?: string }): Promise<ChatResult> {
  if (options?.useCase === "fact_conflict") return chat(mock.judge());
  if (options?.useCase === "fact_relations") return chat(mock.relations());
  if (mock.throwOnExtract) throw new Error("extraction LLM down");
  return chat(mock.extract());
}

const embed = async (): Promise<number[]> => FIXED_VEC;

async function createUserConversation(): Promise<void> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
}

async function addMessages(contents: string[], from: Date, to: Date): Promise<void> {
  let t = from.getTime() + 1;
  for (const c of contents) {
    await prisma.message.create({ data: { conversationId, role: "assistant", content: c, createdAt: new Date(t) } });
    t += 1000;
  }
  // make sure `to` is after the last message
  if (t > to.getTime()) throw new Error("test bug: to must be after message timestamps");
}

const listAll = () => prisma.extractedFact.findMany({ where: { conversationId } });

// Clear facts + any FactRelation rows referencing them (relations FK to facts,
// so facts must be removed last). Used by every test that resets the slate.
async function clearFacts(): Promise<void> {
  const ids = (await prisma.extractedFact.findMany({ where: { conversationId }, select: { id: true } })).map((f) => f.id);
  if (ids.length > 0) {
    await prisma.factRelation.deleteMany({ where: { OR: [{ sourceFactId: { in: ids } }, { targetFactId: { in: ids } }] } });
  }
  await prisma.extractedFact.deleteMany({ where: { conversationId } });
}

beforeAll(async () => {
  await createUserConversation();
});

afterAll(async () => {
  await clearFacts();
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("extractFacts — write path", () => {
  test("a message range with a durable fact creates an ExtractedFact row", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 60_000);
    await addMessages(["I'm paying $1200 a month in rent now, by the way."], from, to);
    mock.extract = () => '{"facts":[{"subject":"rent","fact":"my rent is $1200/mo"}]}';

    const res = await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(0);
    const rows = await listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("rent");
    expect(rows[0]!.fact).toBe("my rent is $1200/mo");
    expect(rows[0]!.status).toBe("active");
  });

  test("a second pass with a CONTRADICTING fact on the same subject supersedes the old, keeps both rows", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 60_000);
    await addMessages(["rent went up — now $1500 a month."], from, to);
    mock.extract = () => '{"facts":[{"subject":"rent","fact":"my rent is now $1500/mo"}]}';
    mock.judge = () => '{"supersede":[true]}';

    const res = await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(1);
    const rows = await listAll();
    expect(rows).toHaveLength(2); // old preserved, NOT deleted
    const old = rows.find((r) => r.fact === "my rent is $1200/mo");
    const fresh = rows.find((r) => r.fact === "my rent is now $1500/mo");
    expect(old?.status).toBe("superseded");
    expect(fresh?.status).toBe("active");
    expect(fresh?.supersedesId).toBe(old?.id); // new points at old
  });

  test("a second pass with a NON-contradicting related fact on the same subject keeps both active", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 60_000);
    await addMessages(["and I live in Seattle these days."], from, to);
    mock.extract = () => '{"facts":[{"subject":"location","fact":"I live in Seattle"}]}';
    mock.judge = () => '{"supersede":[false]}';

    const res = await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(0);
    const rows = await listAll();
    const loc = rows.filter((r) => r.subject === "location");
    expect(loc).toHaveLength(1);
    expect(loc[0]!.status).toBe("active");
  });

  test("extraction LLM failure is fail-open: no throw, no rows, sweep not blocked", async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 60_000);
    await addMessages(["some content that would fail"], from, to);
    mock.throwOnExtract = true;

    let threw = false;
    let res: { inserted: number; superseded: number } | null = null;
    try {
      res = await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });
    } catch {
      threw = true;
    } finally {
      mock.throwOnExtract = false;
    }

    expect(threw).toBe(false);
    expect(res).toEqual({ inserted: 0, superseded: 0 });
  });

  test("unparseable extraction output is fail-open (empty result)", () => {
    expect(parseExtractedFacts("not json at all")).toEqual([]);
    expect(parseExtractedFacts('{"facts":[{"subject":"x"}]}')).toEqual([]); // missing fact
  });

  test("typed facts default to other/attribute when absent, preserve when present", async () => {
    expect(parseExtractedFacts('{"facts":[{"subject":"p","fact":"f"}]}')).toEqual([
      { subject: "p", fact: "f", subjectType: "other", factType: "attribute" },
    ]);
    expect(parseExtractedFacts('{"facts":[{"subject":"p","fact":"f","subjectType":"person","factType":"event"}]}')).toEqual([
      { subject: "p", fact: "f", subjectType: "person", factType: "event" },
    ]);
  });
});

describe("parseFactRelations — confidence gate + shape", () => {
  test("drops confidence < 0.6 and malformed entries, keeps >= 0.6", () => {
    const ok = '{"relations":[{"sourceIndex":0,"targetIndex":1,"relationType":"affects","confidence":0.9},{"sourceIndex":0,"targetIndex":2,"confidence":0.4}]}';
    expect(parseFactRelations(ok)).toEqual([{ sourceIndex: 0, targetIndex: 1, relationType: "affects", confidence: 0.9 }]);
    expect(parseFactRelations("garbage")).toEqual([]);
  });
});

describe("extractFacts — 10.6 relation graph", () => {
  test("a relation is written between a new fact and a compatible existing fact", async () => {
    await clearFacts();
    const existing = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "acme", fact: "Acme builds analytics software", status: "active", subjectType: "project", factType: "attribute" },
    });

    const from = new Date();
    const to = new Date(from.getTime() + 30000);
    await addMessages(["Acme is opening a Berlin office."], from, to);
    mock.extract = () => '{"facts":[{"subject":"acme","fact":"acme opens berlin office","subjectType":"project","factType":"event"}]}';
    mock.relations = () => '{"relations":[{"sourceIndex":0,"targetIndex":0,"relationType":"predecessor_of","confidence":0.9}]}';

    await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    const rel = await prisma.factRelation.findFirst({ where: { targetFactId: existing.id } });
    expect(rel?.relationType).toBe("predecessor_of");
    mock.relations = () => '{"relations":[]}';
  });

  test("a low-confidence relation is not written", async () => {
    await clearFacts();
    const existing = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "acme", fact: "Acme builds analytics software", status: "active", subjectType: "project", factType: "attribute" },
    });

    const from = new Date();
    const to = new Date(from.getTime() + 30000);
    await addMessages(["Acme is opening a Berlin office."], from, to);
    mock.extract = () => '{"facts":[{"subject":"acme","fact":"acme opens berlin office","subjectType":"project","factType":"event"}]}';
    mock.relations = () => '{"relations":[{"sourceIndex":0,"targetIndex":0,"relationType":"predecessor_of","confidence":0.3}]}';

    await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    expect(await prisma.factRelation.count({ where: { targetFactId: existing.id } })).toBe(0);
    mock.relations = () => '{"relations":[]}';
  });

  test("incompatible subject types produce no relation edge", async () => {
    await clearFacts();
    const existing = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "acme", fact: "Acme Corp builds software", status: "active", subjectType: "credential", factType: "attribute" },
    });

    const from = new Date();
    const to = new Date(from.getTime() + 30000);
    await addMessages(["acme is opening berlin office"], from, to);
    mock.extract = () => '{"facts":[{"subject":"acme","fact":"berlin office","subjectType":"person","factType":"event"}]}';
    mock.relations = () => '{"relations":[{"sourceIndex":0,"targetIndex":0,"relationType":"x","confidence":0.9}]}';

    await extractFacts(conversationId, from, to, { caller: fakeCaller, embed });

    expect(await prisma.factRelation.count({ where: { targetFactId: existing.id } })).toBe(0);
    mock.relations = () => '{"relations":[]}';
  });
});

describe("searchActiveFacts — retrieval (ACTIVE only, by construction)", () => {
  test("returns only ACTIVE facts ranked by relevance, never superseded", async () => {
    // Clean slate for this conversation to control the vector space precisely.
    await clearFacts();
    await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "proj", fact: "deadline is Friday", status: "active" },
    });
    await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "proj", fact: "owner is Priya", status: "active" },
    });
    await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "proj", fact: "budget is 10k", status: "superseded" },
    });
    const rows = await prisma.extractedFact.findMany({ where: { conversationId } });
    const byFact = (f: string) => rows.find((r) => r.fact === f)!;
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${byFact("deadline is Friday").id}`;
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(1))}::vector WHERE id = ${byFact("owner is Priya").id}`;
    // superseded row would rank high on the deadline query if not excluded
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${byFact("budget is 10k").id}`;

    const hits = await searchActiveFacts(conversationId, "when is the project deadline", {
      embed: async () => vec(0),
    });

    expect(hits[0]!.fact).toBe("deadline is Friday"); // ranks top by relevance
    expect(hits[0]!.similarity).toBeGreaterThan(0.9);
    // a superseded row with the SAME embedding as the top hit never appears
    expect(hits.some((h) => h.fact === "budget is 10k")).toBe(false);
  });

  // Regression for the $queryRaw binding bug. The production query must filter
  // `status = 'active'` INLINE — if that literal is ever interpolated as a JS
  // value, Prisma $queryRaw binds it as a string parameter, which is always
  // truthy in a WHERE clause and silently disables the status filter. A query
  // broken that way can either (a) return the inactive row (caught by
  // .not.toContain) or (b) error into searchActiveFacts's fail-open [] (which
  // an only-inactive assertion would pass vacuously). So BOTH sides are asserted:
  // the active control row MUST come back, and a superseded row sharing the
  // exact top embedding MUST NOT.
  test("real query excludes an inactive-status row that shares the top embedding", async () => {
    await clearFacts();
    const active = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "proj", fact: "active control", status: "active" },
    });
    const inactive = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "proj", fact: "inactive but highest-similarity", status: "superseded" },
    });
    // BOTH rows get exactly the query vector, so if the status filter is broken
    // the inactive row is the (co-)top hit and leaks into results.
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${active.id}`;
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${inactive.id}`;

    const hits = await searchActiveFacts(conversationId, "top-similarity question", {
      embed: async () => vec(0),
    });

    // Control: the active row is visible (catches a broken filter erroring to []).
    expect(hits.map((h) => h.id)).toContain(active.id);
    // The inactive row never appears, even though its embedding ties the query.
    expect(hits.map((h) => h.id)).not.toContain(inactive.id);
    expect(hits.some((h) => h.fact === "inactive but highest-similarity")).toBe(false);
  });
});

describe("searchActiveFactsWithRelations — 10.8 hybrid + 10.6 expansion", () => {
  test("lexical side alone returns a fact when the embed fails (fail-open to lexical)", async () => {
    await clearFacts();
    await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "rent", fact: "our rent is 1500 dollars a month", status: "active" },
    });
    const hits = await searchActiveFactsWithRelations(conversationId, "how much rent", {
      embed: async () => {
        throw new Error("embed down");
      },
    });
    expect(hits.some((h) => h.fact.includes("rent"))).toBe(true);
  });

  test("vector hit surfaces and a relation neighbor expands it", async () => {
    await clearFacts();
    const rent = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "rent", fact: "office space costs 900 monthly", status: "active" },
    });
    const office = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "office", fact: "kkar zzibble wuzzle blynk", status: "active" },
    });
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${rent.id}`;
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(1))}::vector WHERE id = ${office.id}`;
    await prisma.factRelation.create({ data: { sourceFactId: rent.id, targetFactId: office.id, relationType: "affects" } });

    const hits = await searchActiveFactsWithRelations(conversationId, "cost of rent", {
      embed: async () => vec(0),
    });
    expect(hits.map((h) => h.id)).toContain(rent.id);
    // the office row has no lexical overlap ("kkar zzibble...") and ranks low on
    // the vector side — only the relation edge to `rent` surfaces it.
    expect(hits.some((h) => h.id === office.id)).toBe(true);
  });
});

describe("deleteFact — soft delete, separate path from supersede", () => {
  test("deleteFact on an active fact flips to deleted with deletedAt/deletedReason, row kept", async () => {
    const row = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "s1", fact: "to delete", status: "active" },
    });

    await deleteFact(row.id, "user_requested");

    const after = await prisma.extractedFact.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("deleted");
    expect(after?.deletedAt).toBeInstanceOf(Date);
    expect(after?.deletedReason).toBe("user_requested");
    expect(after?.fact).toBe("to delete"); // row still exists
  });

  test("a deleted fact NEVER appears in top-K retrieval even when it would rank highest", async () => {
    // Clean slate.
    await clearFacts();
    const active = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "d", fact: "active fact", status: "active" },
    });
    const doomed = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "d", fact: "perfectly relevant fact", status: "active" },
    });
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(3))}::vector WHERE id = ${active.id}`;
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(0))}::vector WHERE id = ${doomed.id}`;
    // Query is closest to the doomed fact — it WOULD rank #1.
    await deleteFact(doomed.id, "incorrect_extraction");

    const hits = await searchActiveFacts(conversationId, "perfectly relevant", {
      embed: async () => vec(0),
    });

    expect(hits.some((h) => h.id === doomed.id)).toBe(false);
    expect(hits.map((h) => h.id)).toContain(active.id);
  });

  test("deleting a fact that a newer fact superseded leaves the newer fact active and retrievable", async () => {
    // Build a chain: old (rent $1200) superseded by new (rent $1500).
    const old = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "rent", fact: "rent is $1200", status: "active" },
    });
    const fresh = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "rent", fact: "rent is $1500", status: "active", supersedesId: old.id },
    });
    await prisma.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${vecLiteral(vec(5))}::vector WHERE id = ${fresh.id}`;
    await prisma.extractedFact.updateMany({ where: { id: old.id }, data: { status: "superseded" } });

    // Delete the OLD link in the chain — must NOT cascade to the newer fact.
    await deleteFact(old.id, "manual_correction");

    const oldAfter = await prisma.extractedFact.findUnique({ where: { id: old.id } });
    const freshAfter = await prisma.extractedFact.findUnique({ where: { id: fresh.id } });
    expect(oldAfter?.status).toBe("deleted"); // old is deleted
    expect(freshAfter?.status).toBe("active"); // newer unaffected
    expect(freshAfter?.supersedesId).toBe(old.id); // chain pointer stays, FK valid

    const hits = await searchActiveFacts(conversationId, "current rent", {
      embed: async () => vec(5),
    });
    expect(hits.some((h) => h.id === fresh.id)).toBe(true);
  });

  test("deleteFact twice is a no-op (idempotent)", async () => {
    const row = await prisma.extractedFact.create({
      data: { conversationId, userId, subject: "s2", fact: "double delete", status: "active" },
    });

    await deleteFact(row.id, "user_requested");
    await deleteFact(row.id, "user_requested"); // second call: 0 rows matched, no throw

    const after = await prisma.extractedFact.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("deleted");
    expect(after?.deletedReason).toBe("user_requested");
  });

  test("deleteFact on a nonexistent id is a no-op (no throw)", async () => {
    await deleteFact("no-such-fact-id", "manual_correction"); // must not throw
  });
});
