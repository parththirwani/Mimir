import { describe, expect, test } from "bun:test";

// email-action.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "email-action-test-secret";

const { parseEmailAction, parseResolveIntent, emailActionHint } = await import("../../email/email-action.js");

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

describe("parseResolveIntent (pending draft decision + edit)", () => {
  const DRAFT = { to: "old@example.com", subject: "Trip", body: "Be ready." };

  test("confirm/cancel/unrelated pass through", () => {
    expect(parseResolveIntent('{"intent":"confirm"}', DRAFT)).toEqual({ intent: "confirm" });
    expect(parseResolveIntent('{"intent":"cancel"}', DRAFT)).toEqual({ intent: "cancel" });
    expect(parseResolveIntent('{"intent":"unrelated"}', DRAFT)).toEqual({ intent: "unrelated" });
  });

  test("edit carries the updated draft, inheriting unchanged fields", () => {
    const r = parseResolveIntent('{"intent":"edit","to":"parththirwani@gmail.com"}', DRAFT);
    expect(r.intent).toBe("edit");
    expect(r.draft).toEqual({ to: "parththirwani@gmail.com", subject: "Trip", body: "Be ready." });
  });

  test("an invalid/edit recipient falls back to the draft's current recipient", () => {
    const r = parseResolveIntent('{"intent":"edit","to":"not-an-email"}', DRAFT);
    expect(r.intent).toBe("edit");
    expect(r.draft?.to).toBe("old@example.com");
  });

  test("unknown intent or garbage -> ambiguous (never a silent send)", () => {
    expect(parseResolveIntent('{"intent":"banana"}', DRAFT)).toEqual({ intent: "ambiguous" });
    expect(parseResolveIntent("just send it please", DRAFT)).toEqual({ intent: "ambiguous" });
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
