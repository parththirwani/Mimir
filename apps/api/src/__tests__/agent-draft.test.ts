import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "agent-draft-test-secret";

const { parseDraftResolveIntent } = await import("../agent/agent-draft.js");
const { parseTriggerProposal } = await import("../agent/agent.js");

describe("parseDraftResolveIntent (4.10 confirmation)", () => {
  test("parses confirm/cancel/unrelated", () => {
    expect(parseDraftResolveIntent('{"intent":"confirm"}')).toBe("confirm");
    expect(parseDraftResolveIntent('{"intent":"cancel"}')).toBe("cancel");
    expect(parseDraftResolveIntent('{"intent":"unrelated"}')).toBe("unrelated");
  });

  test("ambiguous on anything else (safe default)", () => {
    expect(parseDraftResolveIntent('{"intent":"ambiguous"}')).toBe("ambiguous");
    expect(parseDraftResolveIntent("nonsense")).toBe("ambiguous");
    expect(parseDraftResolveIntent('{"intent":"sideways"}')).toBe("ambiguous");
  });
});

describe("parseTriggerProposal (4.11 trigger extraction)", () => {
  test("detects an implicit watch-for trigger with criteria", () => {
    const p = parseTriggerProposal('{"hasTrigger":true,"name":"bob","criteria":"an email arrives from bob@example.com"}');
    expect(p.hasTrigger).toBe(true);
    expect(p.name).toBe("bob");
    expect(p.criteria).toBe("an email arrives from bob@example.com");
  });

  test("no trigger on hasTrigger:false or garbage", () => {
    expect(parseTriggerProposal('{"hasTrigger":false}').hasTrigger).toBe(false);
    expect(parseTriggerProposal("garbage").hasTrigger).toBe(false);
    expect(parseTriggerProposal('{"hasTrigger":true,"criteria":null}').hasTrigger).toBe(false);
  });
});