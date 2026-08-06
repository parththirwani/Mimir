import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "mail-poll-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GMAIL_INTEGRATION } = await import("@mimir/connection-provider");
const { pollImportantMail } = await import("../infra/mail-poll.js");
import type { MailPollDeps } from "../infra/mail-poll.js";

const prisma = getPrismaClient();
const userId = `mail-poll-${randomUUID()}`;
const email = `${userId}@test.local`;

// SurfacedMail is keyed on a GLOBAL messageId PK — real Gmail ids are globally
// unique, but tests must be too or a row left by an earlier run permanently
// dedups a reused id. Generate per-run ids so consecutive runs can't collide.
const mid = () => `mail-${randomUUID()}`;
const M1 = mid();
const M2 = mid();
const M3 = mid();
const M4 = mid();
const M5 = mid();

const msg = (id: string, subject: string) => ({
  id,
  from: "Alice <alice@example.com>",
  subject,
  body: "quick check-in",
  receivedAt: "2024-08-02T12:00:00.000Z",
});

// In-memory Redis subset so the noise-cooldown tests are deterministic and
// don't share state with the real redis-backed dedup tests.
function fakeCache(): Redis {
  const sets = new Map<string, Set<string>>();
  return {
    sismember: async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0),
    sadd: async (key: string, member: string) => {
      const s = sets.get(key) ?? new Set<string>();
      const added = s.has(member) ? 0 : 1;
      s.add(member);
      sets.set(key, s);
      return added;
    },
    ttl: async (key: string) => (sets.has(key) ? 60 : -2),
    expire: async () => 1,
  } as unknown as Redis;
}

// Scope the injected fetch to THIS user: the shared test DB holds "connected"
// Gmail rows from other test files (e.g. nango-provider.test), and the sweep
// iterates every connected user. Only our user returns mail.
function mailDeps(messages: ReturnType<typeof msg>[], overrides: Partial<MailPollDeps> = {}): MailPollDeps {
  return {
    fetch: async (forUserId: string) =>
      forUserId === userId ? { provider: "gmail", messages } : { provider: "gmail", messages: [] },
    filter: async () => ({
      surface: true,
      rationale: "urgent",
      category: "actionable" as const,
    }),
    publish: async () => {},
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({
    data: { userId, provider: GMAIL_INTEGRATION, connectionId: `nango-${userId}`, status: "connected" },
  });
  await prisma.conversation.create({ data: { userId } });
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.surfacedMail.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("pollImportantMail (lazy sweep)", () => {
  test("surfaces a new important mail into the user's conversation once", async () => {
    const surfaced = await pollImportantMail(mailDeps([msg(M1, "URGENT")]));
    expect(surfaced).toBe(1);

    const messages = await prisma.message.findMany({
      where: { conversation: { userId }, role: "assistant" },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("URGENT");
  });

  test("a second sweep with the same mail does not re-surface (dedup)", async () => {
    const surfaced = await pollImportantMail(mailDeps([msg(M1, "URGENT")]));
    expect(surfaced).toBe(0);
    const messages = await prisma.message.findMany({ where: { conversation: { userId } } });
    expect(messages).toHaveLength(1);
  });

  test("durable claim survives a Redis flush (Postgres-claimed dedup)", async () => {
    // Surface once with a throwaway cache, then re-sweep with a DIFFERENT fresh
    // cache that has no memory of the surfaced id — simulating a Redis loss.
    const first = await pollImportantMail(mailDeps([msg(M5, "Durable")], { cache: fakeCache() }));
    expect(first).toBe(1);
    const msgs = await prisma.message.findMany({ where: { conversation: { userId } } });
    const countBefore = msgs.length;

    const second = await pollImportantMail(mailDeps([msg(M5, "Durable")], { cache: fakeCache() }));
    expect(second).toBe(0);
    const after = await prisma.message.findMany({ where: { conversation: { userId } } });
    expect(after).toHaveLength(countBefore);
  });

  test("a noise verdict is held in cooldown, not surfaced and not re-judged until it lapses", async () => {
    const cache = fakeCache();
    const noiseFilter = async () => ({ surface: false, rationale: "newsletter", category: "noise" as const });
    const first = await pollImportantMail(mailDeps([msg(M2, "Weekly promo")], { cache, filter: noiseFilter }));
    expect(first).toBe(0);

    // Within the cooldown window a re-sweep does not re-judge the mail.
    const reJudged: unknown[] = [];
    const again = await pollImportantMail(
      mailDeps([msg(M2, "Weekly promo")], {
        cache,
        filter: async (...args: unknown[]) => {
          reJudged.push(args);
          return { surface: true, rationale: "ok", category: "actionable" as const };
        },
      }),
    );
    expect(again).toBe(0);
    expect(reJudged).toHaveLength(0);
  });

  test("after the noise cooldown lapses, a previously-noise mail can be re-judged and surface", async () => {
    const cache = fakeCache();
    const noiseFilter = async () => ({ surface: false, rationale: "newsletter", category: "noise" as const });
    await pollImportantMail(mailDeps([msg(M3, "Weekly promo")], { cache, filter: noiseFilter }));

    // Fresh cache simulates the cooldown expiring; the mail is now re-judged.
    const surfaced = await pollImportantMail(mailDeps([msg(M3, "Weekly promo")], { cache: fakeCache() }));
    expect(surfaced).toBe(1);
  });

  test("judges mail with the email-aware filter kind", async () => {
    const kinds: unknown[] = [];
    const surfaced = await pollImportantMail(
      mailDeps([msg(M4, "Invitation: Product sync")], {
        cache: fakeCache(),
        filter: async (_userId, _content, kind) => {
          kinds.push(kind);
          return { surface: true, rationale: "ok", category: "actionable" as const };
        },
      }),
    );
    expect(surfaced).toBe(1);
    expect(kinds).toEqual(["email"]);
  });
});