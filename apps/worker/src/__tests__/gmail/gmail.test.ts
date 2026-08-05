import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "gmail-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ConnectionError, ProviderError } = await import("@mimir/connection-provider");
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

// This file stubs globalThis.fetch for the REST mocks; restore it so later test
// files' HTTP calls aren't hijacked by the last canned response.
const originalFetch = globalThis.fetch;

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

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
});

afterAll(async () => {
  (globalThis.fetch as unknown) = originalFetch;
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("fetchEntityData", () => {
  test("no connection row -> ConnectionError(not_connected), no Nango/fetch involved", async () => {
    expect(fetchEntityData(userId, "gmail", "watch my email")).rejects.toThrow(ConnectionError);
  });

  test("non-gmail entity -> the mock's fallback shape without the mock flag", async () => {
    expect(await fetchEntityData(userId, "calendar", "check my calendar")).toEqual({
      provider: "calendar",
      items: [],
    });
  });
});

describe("fetchGmailMessages (canned Gmail JSON via mocked fetch)", () => {
  test("builds the {provider-agnostic} message shape", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages?maxResults")) {
        return new Response(JSON.stringify(cannedList), { status: 200 });
      }
      const id = /messages\/([^?]+)/.exec(url)?.[1];
      return new Response(JSON.stringify(cannedDetail(id!)), { status: 200 });
    }) as typeof fetch;

    const messages = await fetchGmailMessages("test-token");
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages?maxResults")) {
        return new Response(JSON.stringify({ messages: [{ id: "msg-1" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const [msg] = await fetchGmailMessages("test-token");
    expect(msg!.listUnsubscribe).toBe("<https://example.com/unsub>");
    expect(msg!.inReplyTo).toBeUndefined();
  });

  test("401 -> ConnectionError(expired)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    expect(fetchGmailMessages("bad-token")).rejects.toThrow(ConnectionError);
    expect(fetchGmailMessages("bad-token")).rejects.toMatchObject({ kind: "expired" });
  });

  test("429 -> ProviderError(rate_limited)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "rate" }), { status: 429 })) as unknown as typeof fetch;
    expect(fetchGmailMessages("test-token")).rejects.toThrow(ProviderError);
    expect(fetchGmailMessages("test-token")).rejects.toMatchObject({ kind: "rate_limited" });
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

describe("createGmailDraft (canned Gmail JSON via mocked fetch)", () => {
  test("POSTs the base64url raw message and returns the draft id", async () => {
    let captured: { url: string; method: string; body: { message: { raw: string } } } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(JSON.stringify({ id: "draft-1", message: { id: "msg-1" } }), { status: 200 });
    }) as typeof fetch;

    const draft = await createGmailDraft("test-token", { from: "me@example.com", to: "alice@example.com", subject: "Hi", body: "hello" });
    expect(draft).toEqual({ id: "draft-1", messageId: "msg-1" });
    expect(captured!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(captured!.method).toBe("POST");
    const raw = Buffer.from(captured!.body.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: alice@example.com");
    expect(raw).toContain("Subject: Hi");
  });

  test("401 -> ConnectionError(expired)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "auth" }), { status: 401 })) as unknown as typeof fetch;
    expect(createGmailDraft("bad-token", { from: "m@x.com", to: "a@x.com", subject: "s", body: "b" })).rejects.toThrow(ConnectionError);
    expect(createGmailDraft("bad-token", { from: "m@x.com", to: "a@x.com", subject: "s", body: "b" })).rejects.toMatchObject({ kind: "expired" });
  });
});

describe("sendGmailDraft (canned Gmail JSON via mocked fetch)", () => {
  test("POSTs the draft id to drafts/send", async () => {
    let captured: { url: string; method: string; body: unknown } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as typeof fetch;

    expect(await sendGmailDraft("test-token", "draft-1")).toBe("sent-1");
    expect(captured!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toEqual({ id: "draft-1" });
  });

  test("429 -> ProviderError(rate_limited)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 429 })) as unknown as typeof fetch;
    expect(sendGmailDraft("test-token", "draft-1")).rejects.toThrow(ProviderError);
    expect(sendGmailDraft("test-token", "draft-1")).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("getGmailProfile (canned Gmail JSON via mocked fetch)", () => {
  test("returns the account emailAddress (used for the From header)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ emailAddress: "me@example.com" }), { status: 200 })) as unknown as typeof fetch;
    expect(await getGmailProfile("test-token")).toBe("me@example.com");
  });

  test("missing emailAddress -> ProviderError(malformed_response)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    expect(getGmailProfile("test-token")).rejects.toMatchObject({ kind: "malformed_response" });
  });
});
