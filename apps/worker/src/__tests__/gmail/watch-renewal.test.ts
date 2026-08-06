import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "watch-renew-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GMAIL_INTEGRATION } = await import("@mimir/connection-provider");
const { registerGmailWatch } = await import("../../integrations/gmail/gmail.js");
const { runWatchRenewal } = await import("../../integrations/gmail/watch-renewal.js");

const prisma = getPrismaClient();
const userId = `watch-${randomUUID()}`;
const email = `${userId}@test.local`;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({ data: { userId, provider: GMAIL_INTEGRATION, connectionId: `n-${userId}`, status: "connected" } });
});

afterAll(async () => {
  (globalThis.fetch as unknown) = originalFetch;
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("registerGmailWatch (6.2.1)", () => {
  test("POSTs the watch body and returns expiration + historyId", async () => {
    let captured: { url: string; method: string; body: unknown } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return new Response(JSON.stringify({ expiration: 1729999999000, historyId: "12345" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await registerGmailWatch("tok", "projects/p/topics/t");
    expect(res).toEqual({ expiration: 1729999999000, historyId: "12345" });
    expect(captured!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/watch");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toMatchObject({ topicName: "projects/p/topics/t", labelIds: ["INBOX"] });
  });

  test("missing historyId -> ProviderError(malformed_response)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    expect(registerGmailWatch("tok", "projects/p/topics/t")).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("runWatchRenewal (6.2.2)", () => {
  test("re-registers a watch for every connected user (idempotent refresh)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ expiration: 1750000000000, historyId: "999" }), { status: 200 })) as unknown as typeof fetch;
    // Shared DB holds other connected users too; assert at least ours.
    const renewed = await runWatchRenewal({ topic: "projects/p/topics/t", getToken: async () => "tok" });
    expect(renewed).toBeGreaterThanOrEqual(1);
  });

  test("no topic configured -> no-op (not an error)", async () => {
    expect(await runWatchRenewal({ topic: undefined })).toBe(0);
  });
});
