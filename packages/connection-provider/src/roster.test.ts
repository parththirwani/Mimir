import { describe, expect, test } from "bun:test";
import { INTERCOM_INTEGRATION, LINEAR_INTEGRATION, SENTRY_INTEGRATION, VERCEL_INTEGRATION, providerFor } from "./roster.js";

const fakeStore = {} as never;

describe("roster providers (5.7.1)", () => {
  test("providerFor builds a provider for any roster key", () => {
    for (const key of [LINEAR_INTEGRATION, VERCEL_INTEGRATION, INTERCOM_INTEGRATION, SENTRY_INTEGRATION]) {
      expect(providerFor(key)({ store: fakeStore })).toBeDefined();
    }
  });

  test("provider keys are distinct and non-empty", () => {
    const keys = [LINEAR_INTEGRATION, VERCEL_INTEGRATION, INTERCOM_INTEGRATION, SENTRY_INTEGRATION];
    expect(new Set(keys).size).toBe(4);
    for (const k of keys) expect(k.length).toBeGreaterThan(0);
  });
});
