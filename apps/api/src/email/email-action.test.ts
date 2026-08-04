import { describe, expect, test } from "bun:test";

// email-action.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "email-action-test-secret";

const { parseEmailAction, parseResolveIntent, emailActionHint } = await import("./email-action.js");

describe("parseEmailAction (structured draft proposal)", () => {
  test("send_email passes through to/subject/body", () => {
    expect(parseEmailAction('{"intent":"send_email","to":"alice@example.com","subject":"Hi","body":"body text"}')).toEqual({
      intent: "send_email",
      to: "alice@example.com",
      subject: "Hi",
      body: "body text",
    });
  });

  test("none intent -> none", () => {
    expect(parseEmailAction('{"intent":"none"}')).toEqual({ intent: "none" });
  });

  test("garbage forces none", () => {
    expect(parseEmailAction("sure, here you go")).toEqual({ intent: "none" });
  });

  test("json fenced in code blocks is handled", () => {
    expect(parseEmailAction('```json\n{"intent":"send_email","to":"alice@example.com","subject":"S","body":"B"}\n```')).toMatchObject({
      intent: "send_email",
      to: "alice@example.com",
    });
  });

  test("recipient is trimmed, missing fields default to empty", () => {
    expect(parseEmailAction('{"intent":"send_email"}')).toEqual({ intent: "send_email", to: "", subject: "", body: "" });
  });
});

describe("parseResolveIntent (pending draft confirm/cancel decision)", () => {
  test("confirm/cancel/unrelated pass through", () => {
    expect(parseResolveIntent('{"intent":"confirm"}')).toBe("confirm");
    expect(parseResolveIntent('{"intent":"cancel"}')).toBe("cancel");
    expect(parseResolveIntent('{"intent":"unrelated"}')).toBe("unrelated");
  });

  test("unknown intent or garbage -> ambiguous (never a silent send)", () => {
    expect(parseResolveIntent('{"intent":"banana"}')).toBe("ambiguous");
    expect(parseResolveIntent("just send it please")).toBe("ambiguous");
  });
});

describe("emailActionHint (cheap pre-LLM gate)", () => {
  test("matches email-ish phrasing", () => {
    expect(emailActionHint("write an email to alice about the project")).toBe(true);
    expect(emailActionHint("draft a reply to bob")).toBe(true);
    expect(emailActionHint("send my mail")).toBe(true);
  });

  test("does not match unrelated messages", () => {
    expect(emailActionHint("what's the weather today")).toBe(false);
    expect(emailActionHint("set a reminder for 6pm")).toBe(false);
  });
});
