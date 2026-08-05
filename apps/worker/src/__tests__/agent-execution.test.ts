import { describe, expect, test } from "bun:test";

// agent-execution.ts loads prisma + config at import time; env must be set first.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "agent-execution-test-secret";

const { userTriggered, filterSystemPrompt } = await import("../agent/agent-execution.js");

describe("userTriggered (surfacing policy)", () => {
  test("a direct user message is always surfaced, never filtered", () => {
    expect(userTriggered("user_message")).toBe(true);
  });

  test("an explicitly-confirmed draft re-run is surfaced, never filtered", () => {
    expect(userTriggered("draft_confirmed")).toBe(true);
  });

  test("background/triggered runs go through the noise filter", () => {
    expect(userTriggered("poll")).toBe(false);
    expect(userTriggered(undefined)).toBe(false);
    expect(userTriggered("webhook")).toBe(false);
    expect(userTriggered("trigger_fired")).toBe(false);
  });
});

describe("filterSystemPrompt (importance rubric)", () => {
  test("the agent rubric stays generic", () => {
    expect(filterSystemPrompt("agent")).not.toContain("Meeting");
  });

  test("the email rubric names meeting invites as actionable", () => {
    const p = filterSystemPrompt("email");
    expect(p).toContain("Meeting, calendar, or appointment invitations");
    expect(p).toContain("List-Unsubscribe");
    expect(p).toContain("In-Reply-To");
    expect(p).toContain('"surface":true');
  });
});
