import { mock } from "bun:test";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "connection-provider-test-secret";

// Intercept @nangohq/node BEFORE the provider imports it. Nango is only
// instantiated lazily, but resolution happens at import time.
const seen = { listConnections: 0, getConnection: 0, deleteConnection: 0 };
mock.module("@nangohq/node", () => {
  const Nango = class {
    async createConnectSession() {
      return { data: { connect_link: "https://connect.nango.dev/abc", token: "t", expires_at: "x" } };
    }
    async listConnections({ tags }: { tags?: Record<string, string> }) {
      seen.listConnections += 1;
      if (tags?.end_user_id === "conn-nobody") return { connections: [] };
      return { connections: [{ connection_id: `nango-${tags?.end_user_id ?? "none"}` }] };
    }
    async getConnection() {
      seen.getConnection += 1;
      return { credentials: { type: "OAUTH2", access_token: "tok", raw: {} } };
    }
    async deleteConnection() {
      seen.deleteConnection += 1;
      return {};
    }
  };
  return { Nango };
});

const { getPrismaClient } = await import("@mimir/backend-core");
const { ConnectionError } = await import("./types.js");
const { NangoConnectionProvider } = await import("./nango-provider.js");

const prisma = getPrismaClient();
const userId = `conn-test-${randomUUID()}`;
const email = `${userId}@test.local`;
const syncUserId = `conn-sync-${randomUUID()}`;
const syncEmail = `${syncUserId}@test.local`;
const hookUserId = `conn-hook-${randomUUID()}`;
const hookEmail = `${hookUserId}@test.local`;

function provider() {
  return new NangoConnectionProvider({ secretKey: "test-secret", store: prisma.integrationConnection });
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.user.create({ data: { id: syncUserId, email: syncEmail, passwordHash: "x" } });
  await prisma.user.create({ data: { id: hookUserId, email: hookEmail, passwordHash: "x" } });
});

afterAll(async () => {
  await prisma.integrationConnection.deleteMany({ where: { userId: { in: [userId, syncUserId, hookUserId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, syncUserId, hookUserId] } } });
});

describe("NangoConnectionProvider", () => {
  test("handleCallback resolves the connection by end_user_id tag and stores the row", async () => {
    await provider().handleCallback(userId);
    expect(seen.listConnections).toBe(1);
    const row = await prisma.integrationConnection.findFirst({ where: { userId, provider: "google-mail" } });
    expect(row?.connectionId).toBe(`nango-${userId}`);
    expect(row?.status).toBe("connected");
  });

  test("getAccessToken reads the stored connectionId and returns the OAuth2 token", async () => {
    await expect(provider().getAccessToken(userId)).resolves.toBe("tok");
    expect(seen.getConnection).toBe(1);
  });

  test("getConnection reports the stored status", async () => {
    await expect(provider().getConnection(userId)).resolves.toEqual({ status: "connected" });
  });

  test("revoke deletes the Nango connection and the local row", async () => {
    await provider().revoke(userId);
    expect(seen.deleteConnection).toBe(1);
    await expect(provider().getConnection(userId)).resolves.toBeNull();
    await expect(provider().getAccessToken(userId)).rejects.toThrow(ConnectionError);
  });
});

describe("syncConnection (reconciliation backstop)", () => {
  test("upserts the tagged Nango connection when no local row exists", async () => {
    expect(await provider().syncConnection(syncUserId)).toBe(true);
    const row = await prisma.integrationConnection.findFirst({ where: { userId: syncUserId, provider: "google-mail" } });
    expect(row?.connectionId).toBe(`nango-${syncUserId}`);
    expect(row?.status).toBe("connected");
  });

  test("uses the passed connectionId and skips the Nango lookup", async () => {
    const calls = seen.listConnections;
    expect(await provider().syncConnection(hookUserId, "nango-explicit")).toBe(true);
    expect(seen.listConnections).toBe(calls);
    const row = await prisma.integrationConnection.findFirst({ where: { userId: hookUserId, provider: "google-mail" } });
    expect(row?.connectionId).toBe("nango-explicit");
  });

  test("returns false when Nango has no tagged connection", async () => {
    expect(await provider().syncConnection("conn-nobody")).toBe(false);
    await expect(provider().getConnection("conn-nobody")).resolves.toBeNull();
  });

  test("no-op when a local row already exists (no Nango call, row unchanged)", async () => {
    const before = await prisma.integrationConnection.findFirst({ where: { userId: syncUserId, provider: "google-mail" } });
    const calls = seen.listConnections;
    expect(await provider().syncConnection(syncUserId)).toBe(true);
    expect(seen.listConnections).toBe(calls);
    const row = await prisma.integrationConnection.findFirst({ where: { userId: syncUserId, provider: "google-mail" } });
    expect(row?.connectionId).toBe(before?.connectionId);
    expect(row?.status).toBe("connected");
  });
});
