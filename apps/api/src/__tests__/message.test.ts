import { describe, expect, test } from "bun:test";
import { mapLLMError } from "../infra/errors.js";

describe("mapLLMError", () => {
  test("not configured -> 503 NOT_CONFIGURED", () => {
    expect(mapLLMError({ code: "NOT_CONFIGURED" })).toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
  });

  test("openrouter 429 -> 429 RATE_LIMITED", () => {
    expect(mapLLMError({ httpStatus: 429 })).toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });

  test("openrouter 5xx -> 502 UPSTREAM_ERROR", () => {
    expect(mapLLMError({ httpStatus: 502 })).toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
  });

  test("retriable (timeout/5xx) -> 504 UPSTREAM_TIMEOUT", () => {
    // timeout surfaces as httpStatus 0 with retriable true
    expect(mapLLMError({ httpStatus: 0, retriable: true })).toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
    expect(mapLLMError({ httpStatus: 503, retriable: true })).toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
  });

  test("unknown -> 500 INTERNAL_ERROR", () => {
    expect(mapLLMError(new Error("x"))).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });
});