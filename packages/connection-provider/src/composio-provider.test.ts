import { describe, expect, test } from "bun:test";
import { ComposioConnectionProvider } from "./composio-provider.js";

// The load-bearing, landmine-guard path: extractAccessToken must return the raw
// Google token when Composio's shape is as documented, and throw loudly
// (ProviderError) whenever the shape drifts — NEVER return undefined. This is
// the regression test for the canary's silent-break detector.
function extract(state: unknown): string {
  const p = new ComposioConnectionProvider({ apiKey: "x", authConfigId: "ac_x", store: parse as never });
  return (p as unknown as { extractAccessToken(s: unknown): string }).extractAccessToken(state);
}
// Never reached — the constructor's store is only touched by methods not called
// here. A non-null cast keeps the test self-contained (no prisma client).
const parse = {};

describe("ComposioConnectionProvider extractAccessToken", () => {
  test("returns the raw token for a healthy OAUTH2 ACTIVE state", () => {
    const token = extract({ authScheme: "OAUTH2", val: { status: "ACTIVE", access_token: "tok-gmail" } });
    expect(token).toBe("tok-gmail");
  });

  test("throws loudly when authScheme is not OAUTH2", () => {
    expect(() => extract({ authScheme: "API_KEY", val: { status: "ACTIVE", api_key: "k" } })).toThrow(/unexpected auth state/);
  });

  test("throws loudly when status is not ACTIVE", () => {
    expect(() => extract({ authScheme: "OAUTH2", val: { status: "EXPIRED", access_token: "tok" } })).toThrow(/no ACTIVE access_token/);
  });

  test("throws loudly when access_token is missing or not a string", () => {
    expect(() => extract({ authScheme: "OAUTH2", val: { status: "ACTIVE" } })).toThrow(/no ACTIVE access_token/);
    expect(() => extract({ authScheme: "OAUTH2", val: { status: "ACTIVE", access_token: 123 } })).toThrow(/no ACTIVE access_token/);
  });

  test("throws loudly when state is absent", () => {
    expect(() => extract(undefined)).toThrow(/unexpected auth state/);
    expect(() => extract(null)).toThrow(/unexpected auth state/);
  });
});