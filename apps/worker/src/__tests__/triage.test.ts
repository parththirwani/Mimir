process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "triage-test-secret";

import { describe, expect, test } from "bun:test";
const { parseTriage } = await import("../agent/triage.js");

describe("parseTriage (6.5.5 stricter bar)", () => {
  test("only an explicit true surfaces", () => {
    expect(parseTriage('{"surface":true,"rationale":"urgent","category":"actionable"}')).toEqual({
      surface: true,
      rationale: "urgent",
      category: "actionable",
    });
    expect(parseTriage('{"surface":false,"rationale":"newsletter","category":"noise"}').surface).toBe(false);
  });

  test("missing surface / unknown category / unparseable default to false + noise", () => {
    expect(parseTriage('{"rationale":"nope"}').surface).toBe(false);
    expect(parseTriage('{"surface":true,"category":"weird"}').category).toBe("noise");
    expect(parseTriage("not json").surface).toBe(false);
  });
});
