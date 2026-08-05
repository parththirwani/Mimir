// Map backend LLM errors to HTTP responses. Standalone (no imports) so it's unit-testable
// without pulling in prisma/otel/config. Duck-types on OpenRouterError/NotConfiguredError.
export function mapLLMError(e: unknown): { status: number; code: string; message: string } {
  if (e && typeof e === "object") {
    const err = e as { code?: string; httpStatus?: number; retriable?: boolean };
    if (err.code === "NOT_CONFIGURED") {
      return { status: 503, code: "NOT_CONFIGURED", message: "LLM is not configured" };
    }
    if (typeof err.httpStatus === "number") {
      if (err.httpStatus === 429) return { status: 429, code: "RATE_LIMITED", message: "LLM rate limit exceeded" };
      return { status: 502, code: "UPSTREAM_ERROR", message: "LLM request failed" };
    }
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected error" };
}