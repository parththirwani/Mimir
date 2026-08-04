import * as Sentry from "@sentry/node";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace } from "@opentelemetry/api";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions";
import { getConfig } from "./config/config.js";

// Module-scope side effect: this file MUST be imported before prisma so the
// Prisma instrumentation registers before that module loads (see app entrypoints).
const cfg = getConfig();

// Application entrypoints create request/job spans manually with this tracer:
// the http/express OTel instrumentations silently no-op under Bun (the runtime
// used here and in the prod images), so relying on them yields zero HTTP spans.
// Request-level spans are all the 1.2.4 dashboard needs; add route-level spans
// (or a working http instrumentation) if per-route granularity is required.
export const tracer = trace.getTracer("mimir");

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.OTEL_SERVICE_NAME ?? "mimir",
    [ATTR_SERVICE_NAMESPACE]: "mimir",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: cfg.NODE_ENV ?? "development",
  }),
  // ponytail: no Grafana creds -> console spans so traces are still visible in dev.
  // Swap is env-var-only (set OTEL_EXPORTER_OTLP_ENDPOINT) once creds exist.
  traceExporter: cfg.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({
        url: tracesUrl(cfg.OTEL_EXPORTER_OTLP_ENDPOINT),
        headers: parseOtlpHeaders(cfg.OTEL_EXPORTER_OTLP_HEADERS),
      })
    : new ConsoleSpanExporter(),
  instrumentations: [new PrismaInstrumentation()],
});
sdk.start();

if (cfg.SENTRY_DSN) {
  Sentry.init({ dsn: cfg.SENTRY_DSN, environment: cfg.NODE_ENV ?? "development" });
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return headers;
}

// The OTLPHTTP exporter takes the passed url verbatim; the OTel env var spec treats
// OTEL_EXPORTER_OTLP_ENDPOINT as a base URL and appends /v1/traces. Normalize so
// Grafana Cloud's documented endpoint (".../otlp") works as-is.
function tracesUrl(endpoint: string): string {
  return endpoint.includes("/v1/traces") ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}
