import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";

// storeWebhook touches the DB; the signature/verify functions are pure.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "webhooks-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { gmailExternalId, isStale, slackSignature, storeWebhook, verifyGithubSignature, verifySlackSignature } = await import("../routes/webhooks.js");

const prisma = getPrismaClient();
const provider = `webhook-test-${randomUUID()}`;

beforeAll(async () => {});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({ where: { provider } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "github" } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "slack" } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "gmail" } });
});

describe("github signature verification (6.1.2)", () => {
  test("accepts a valid HMAC-SHA256 signature", () => {
    const raw = JSON.stringify({ action: "opened", delivery: "d1" });
    const sig = createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifyGithubSignature(raw, `sha256=${sig}`, "secret")).toBe(true);
  });

  test("rejects a wrong signature and a missing header", () => {
    expect(verifyGithubSignature('{"x":1}', "sha256=deadbeef", "secret")).toBe(false);
    expect(verifyGithubSignature('{"x":1}', undefined, "secret")).toBe(false);
  });

  test("rejects a different secret", () => {
    const raw = '{"x":1}';
    const sig = createHmac("sha256", "other").update(raw).digest("hex");
    expect(verifyGithubSignature(raw, `sha256=${sig}`, "secret")).toBe(false);
  });
});

describe("slack signature verification (6.1.2)", () => {
  test("accepts a valid versioned signature", () => {
    const body = '{"event_id":"e1"}';
    const sig = `v0=${slackSignature("secret", "1700000000", body)}`;
    expect(verifySlackSignature(body, "1700000000", sig, "secret")).toBe(true);
  });

  test("rejects a tampered body / wrong secret / missing parts", () => {
    const body = '{"event_id":"e1"}';
    const sig = `v0=${slackSignature("secret", "1700000000", body)}`;
    expect(verifySlackSignature('{"event_id":"EVIL"}', "1700000000", sig, "secret")).toBe(false);
    expect(verifySlackSignature(body, "1700000000", sig, "wrong")).toBe(false);
    expect(verifySlackSignature(body, undefined, sig, "secret")).toBe(false);
  });
});

describe("replay protection (6.1.3)", () => {
  test("rejects a timestamp older than 5 minutes", () => {
    const now = 1_000_000;
    expect(isStale(now - 6 * 60 * 1000, now)).toBe(true);
  });

  test("accepts a fresh timestamp and rejects non-finite", () => {
    const now = 1_000_000;
    expect(isStale(now - 60 * 1000, now)).toBe(false);
    expect(isStale(NaN, now)).toBe(true);
  });
});

describe("storeWebhook (6.1.4 idempotency)", () => {
  test("stores a new event once and treats the duplicate as a no-op", async () => {
    const id = `wh-${randomUUID()}`;
    const first = await storeWebhook(provider, id, { hello: "world" });
    expect(first.stored).toBe(true);
    expect(first.id).toBeTruthy();

    const dup = await storeWebhook(provider, id, { hello: "world" });
    expect(dup.stored).toBe(false);
    expect(dup.id).toBe(first.id);

    expect(await prisma.webhookEvent.count({ where: { provider, externalId: id } })).toBe(1);
  });
});

describe("gmailExternalId (6.1.4 mailbox-namespaced dedup)", () => {
  test("two different mailboxes at the same historyId get distinct ids (no cross-user drop)", () => {
    const a = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    const b = gmailExternalId({ historyId: "500", emailAddress: "bob@gmail.com" }, "x");
    expect(a).not.toBe(b);
    expect(a).toContain("alice@gmail.com:500");
    expect(b).toContain("bob@gmail.com:500");
  });

  test("same mailbox + historyId is stable (dedup still works)", () => {
    const a = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    const b = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    expect(a).toBe(b);
  });
});
