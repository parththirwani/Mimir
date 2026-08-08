import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "gmail-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ConnectionError, ProviderError } = await import("@mimir/connection-provider");
import type { GmailTransport } from "../../integrations/gmail/gmail.js";
const {
  fetchEntityData,
  fetchGmailMessages,
  buildRawMessage,
  createGmailDraft,
  sendGmailDraft,
  getGmailProfile,
} = await import("../../integrations/gmail/gmail.js");

const prisma = getPrismaClient();
const userId = `gmail-test-${randomUUID()}`;
const email = `${userId}@test.local`;

const cannedList = { messages: [{ id: "msg-1" }, { id: "msg-2" }] };
const cannedDetail = (id: string) => ({
  id,
  snippet: "quick check-in on the design doc",
  internalDate: "1722600000000",
  payload: {
    headers: [
      { name: "From", value: "Alice Johnson <alice@example.com>" },
      { name: "Subject", value: "Project update" },
      { name: "In-Reply-To", value: "<thread-123@example.com>" },
    ],
  },
});

function okTransport(data: unknown): GmailTransport {
  return async () => ({ status: 200, data });
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
});

afterAll(async () => {
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("fetchEntityData", () => {
  test("no connection row -> ConnectionError(not_connected), no provider/fetch involved", async () => {
    expect(fetchEntityData(userId, "gmail", "watch my email")).rejects.toThrow(ConnectionError);
  });

  test("non-gmail entity -> the fallback shape without the mock flag", async () => {
    expect(await fetchEntityData(userId, "calendar", "check my calendar")).toEqual({
      provider: "calendar",
      items: [],
    });
  });
});

describe("fetchGmailMessages (canned Gmail JSON via stub transport)", () => {
  test("builds the {provider-agnostic} message shape", async () => {
    const transport: GmailTransport = (path) => {
      if (path === "/gmail/v1/users/me/messages") return Promise.resolve({ status: 200, data: cannedList });
      const id = /\/messages\/([^/]+)$/.exec(path)?.[1];
      return Promise.resolve({ status: 200, data: cannedDetail(id!) });
    };

    const messages = await fetchGmailMessages(transport);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: "msg-1",
      from: "Alice Johnson <alice@example.com>",
      subject: "Project update",
      body: "quick check-in on the design doc",
      receivedAt: "2024-08-02T12:00:00.000Z",
      inReplyTo: "<thread-123@example.com>",
    });
  });

  test("captures List-Unsubscribe for bulk mailers and omits absent headers", async () => {
    const transport: GmailTransport = (path) => {
      if (path === "/gmail/v1/users/me/messages")
        return Promise.resolve({ status: 200, data: { messages: [{ id: "msg-1" }] } });
      return Promise.resolve({
        status: 200,
        data: {
          id: "msg-1",
          snippet: "newsletter",
          internalDate: "1722600000000",
          payload: {
            headers: [
              { name: "From", value: "News <noreply@example.com>" },
              { name: "Subject", value: "This week" },
              { name: "List-Unsubscribe", value: "<https://example.com/unsub>" },
            ],
          },
        },
      });
    };

    const [msg] = await fetchGmailMessages(transport);
    expect(msg!.listUnsubscribe).toBe("<https://example.com/unsub>");
    expect(msg!.inReplyTo).toBeUndefined();
  });

  test("401 -> ConnectionError(expired)", async () => {
    const transport: GmailTransport = async () => ({ status: 401, data: { error: "unauthorized" } });
    expect(fetchGmailMessages(transport)).rejects.toThrow(ConnectionError);
    expect(fetchGmailMessages(transport)).rejects.toMatchObject({ kind: "expired" });
  });

  test("429 -> ProviderError(rate_limited)", async () => {
    const transport: GmailTransport = async () => ({ status: 429, data: { error: "rate" } });
    expect(fetchGmailMessages(transport)).rejects.toThrow(ProviderError);
    expect(fetchGmailMessages(transport)).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("buildRawMessage (RFC 2822 for Gmail drafts)", () => {
  const msg = { from: "me@example.com", to: "alice@example.com", subject: "Project update", body: "hi there" };

  test("ASCII subject stays raw; body is base64 under UTF-8 text/plain", () => {
    const raw = buildRawMessage(msg);
    expect(raw).toContain("Subject: Project update\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    expect(raw).toContain("Content-Transfer-Encoding: base64\r\n");
    const body64 = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body64, "base64").toString("utf8")).toBe("hi there");
  });

  test("non-ASCII subject is RFC 2047 B-encoded", () => {
    const raw = buildRawMessage({ ...msg, subject: "café ☕", body: "héllo" });
    const subjectLine = raw.split("\r\n").find((l) => l.startsWith("Subject: "));
    expect(subjectLine).toBe(`Subject: =?UTF-8?B?${Buffer.from("café ☕", "utf8").toString("base64")}?=`);
    const body64 = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body64, "base64").toString("utf8")).toBe("héllo");
  });
});

describe("createGmailDraft (canned Gmail JSON via stub transport)", () => {
  test("POSTs the base64url raw message and returns the draft id", async () => {
    let captured: { path: string; method: string; body: { message: { raw: string } } } | undefined;
    const transport: GmailTransport = async (path, opts) => {
      captured = { path, method: opts?.method ?? "GET", body: opts?.body as { message: { raw: string } } };
      return { status: 200, data: { id: "draft-1", message: { id: "msg-1" } } };
    };

    const draft = await createGmailDraft(transport, { from: "me@example.com", to: "alice@example.com", subject: "Hi", body: "hello" });
    expect(draft).toEqual({ id: "draft-1", messageId: "msg-1" });
    expect(captured!.path).toBe("/gmail/v1/users/me/drafts");
    expect(captured!.method).toBe("POST");
    const raw = Buffer.from(captured!.body.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: alice@example.com");
    expect(raw).toContain("Subject: Hi");
  });

  test("401 -> ConnectionError(expired)", async () => {
    const transport: GmailTransport = async () => ({ status: 401, data: { error: "auth" } });
    expect(createGmailDraft(transport, { from: "m@x.com", to: "a@x.com", subject: "s", body: "b" })).rejects.toThrow(
      ConnectionError,
    );
    expect(createGmailDraft(transport, { from: "m@x.com", to: "a@x.com", subject: "s", body: "b" })).rejects.toMatchObject({
      kind: "expired",
    });
  });
});

describe("sendGmailDraft (canned Gmail JSON via stub transport)", () => {
  test("POSTs the draft id to drafts/send", async () => {
    let captured: { path: string; method: string; body: unknown } | undefined;
    const transport: GmailTransport = async (path, opts) => {
      captured = { path, method: opts?.method ?? "GET", body: opts?.body };
      return { status: 200, data: { id: "sent-1" } };
    };

    expect(await sendGmailDraft(transport, "draft-1")).toBe("sent-1");
    expect(captured!.path).toBe("/gmail/v1/users/me/drafts/send");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toEqual({ id: "draft-1" });
  });

  test("429 -> ProviderError(rate_limited)", async () => {
    const transport: GmailTransport = async () => ({ status: 429, data: {} });
    expect(sendGmailDraft(transport, "draft-1")).rejects.toThrow(ProviderError);
    expect(sendGmailDraft(transport, "draft-1")).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("getGmailProfile (canned Gmail JSON via stub transport)", () => {
  test("returns the account emailAddress (used for the From header)", async () => {
    expect(await getGmailProfile(okTransport({ emailAddress: "me@example.com" }))).toBe("me@example.com");
  });

  test("missing emailAddress -> ProviderError(malformed_response)", async () => {
    expect(getGmailProfile(okTransport({}))).rejects.toMatchObject({ kind: "malformed_response" });
  });
});
