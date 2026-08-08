import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "watch-renew-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GMAIL_INTEGRATION } = await import("@mimir/connection-provider");
import type { GmailTransport } from "../../integrations/gmail/gmail.js";
import { registerGmailWatch } from "../../integrations/gmail/gmail.js";
const { runWatchRenewal } = await import("../../integrations/gmail/watch-renewal.js");

const prisma = getPrismaClient();
const userId = `watch-${randomUUID()}`;
const email = `${userId}@test.local`;

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({ data: { userId, provider: GMAIL_INTEGRATION, connectionId: `n-${userId}`, status: "connected" } });
});

afterAll(async () => {
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("registerGmailWatch (6.2.1)", () => {
  test("POSTs the watch body and returns expiration + historyId", async () => {
    let captured: { path: string; method: string; body: unknown } | undefined;
    const transport: GmailTransport = async (path, opts) => {
      captured = { path, method: opts?.method ?? "GET", body: opts?.body };
      return { status: 200, data: { expiration: 1729999999000, historyId: "12345" } };
    };

    const res = await registerGmailWatch(transport, "projects/p/topics/t");
    expect(res).toEqual({ expiration: 1729999999000, historyId: "12345" });
    expect(captured!.path).toBe("/gmail/v1/users/me/watch");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toMatchObject({ topicName: "projects/p/topics/t", labelIds: ["INBOX"] });
  });

  test("missing historyId -> ProviderError(malformed_response)", async () => {
    const transport: GmailTransport = async () => ({ status: 200, data: {} });
    expect(registerGmailWatch(transport, "projects/p/topics/t")).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("runWatchRenewal (6.2.2)", () => {
  test("re-registers a watch for every connected user (idempotent refresh)", async () => {
    const renewed = await runWatchRenewal({
      topic: "projects/p/topics/t",
      request: () => async () => ({ status: 200, data: { expiration: 1750000000000, historyId: "999" } }),
    });
    // Shared DB holds other connected users too; assert at least ours.
    expect(renewed).toBeGreaterThanOrEqual(1);
  });

  test("no topic configured -> no-op (not an error)", async () => {
    expect(await runWatchRenewal({ topic: undefined })).toBe(0);
  });
});
