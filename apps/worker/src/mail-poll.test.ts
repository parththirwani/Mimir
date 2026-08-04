import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "mail-poll-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GMAIL_INTEGRATION } = await import("@mimir/connection-provider");
const { pollImportantMail } = await import("./mail-poll.js");

const prisma = getPrismaClient();
const userId = `mail-poll-${randomUUID()}`;
const email = `${userId}@test.local`;

const msg = (id: string, subject: string) => ({
  id,
  from: "Alice <alice@example.com>",
  subject,
  body: "quick check-in",
  receivedAt: "2024-08-02T12:00:00.000Z",
});

// Scope the injected fetch to THIS user: the shared test DB holds "connected"
// Gmail rows from other test files (e.g. nango-provider.test), and the sweep
// iterates every connected user. Only our user returns mail.
function deps(messages: ReturnType<typeof msg>[], verdict = "actionable") {
  return {
    fetch: async (forUserId: string) =>
      forUserId === userId ? { provider: "gmail", messages } : { provider: "gmail", messages: [] },
    filter: async () => ({
      surface: verdict !== "noise",
      rationale: "urgent",
      category: verdict as "actionable",
    }),
    publish: async () => {},
  };
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({
    data: { userId, provider: GMAIL_INTEGRATION, nangoConnectionId: `nango-${userId}`, status: "connected" },
  });
  await prisma.conversation.create({ data: { userId } });
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversation: { userId } } });
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("pollImportantMail (lazy sweep)", () => {
  test("surfaces a new important mail into the user's conversation once", async () => {
    const surfaced = await pollImportantMail(deps([msg("mail-1", "URGENT")]));
    expect(surfaced).toBe(1);

    const messages = await prisma.message.findMany({
      where: { conversation: { userId }, role: "assistant" },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("URGENT");
  });

  test("a second sweep with the same mail does not re-surface (dedup)", async () => {
    const surfaced = await pollImportantMail(deps([msg("mail-1", "URGENT")]));
    expect(surfaced).toBe(0);
    const messages = await prisma.message.findMany({ where: { conversation: { userId } } });
    expect(messages).toHaveLength(1);
  });

  test("a noise verdict is not surfaced but is still deduped", async () => {
    const surfaced = await pollImportantMail(deps([msg("mail-2", "spam special offer")], "noise"));
    expect(surfaced).toBe(0);
    // Deduped regardless: a later re-sweep with a surfacing verdict won't emit it.
    const again = await pollImportantMail(deps([msg("mail-2", "spam special offer")], "actionable"));
    expect(again).toBe(0);
  });
});