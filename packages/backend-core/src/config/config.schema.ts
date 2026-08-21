import { z } from "zod";

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().min(1).optional(),
  WEB_APP_URL: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  NANGO_SECRET_KEY: z.string().min(1).optional(),
  NANGO_BASE_URL: z.string().min(1).optional(), // self-hosted Nango only; cloud omits it
  // Composio — the primary Gmail connection provider (No connection caps;
  // metered on tool calls). Absent => the gmail factory falls back to Nango.
  COMPOSIO_API_KEY: z.string().min(1).optional(),
  COMPOSIO_BASE_URL: z.string().min(1).optional(),
  // Composio auth config id for the Gmail toolkit (an auth config is required
  // to reach a connected account's token). Falls back to managed Gmail if unset.
  COMPOSIO_GMAIL_AUTH_CONFIG: z.string().min(1).optional(),
  BROWSERBASE_API_KEY: z.string().min(1).optional(),
  BROWSERBASE_PROJECT_ID: z.string().min(1).optional(),
  // Empty (or unset) = allow all; set to a comma-separated list to restrict.
  BROWSER_ALLOWED_DOMAINS: z.string().optional(),
  BROWSER_DENIED_DOMAINS: z.string().optional(),
  SENTRY_DSN: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
  NODE_ENV: z.string().min(1).optional(),
  // Webhook verification secrets. Absent => the corresponding endpoint
  // returns 503 NOT_CONFIGURED (feature-gated per provider).
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  // Gmail push: the public base URL of the api so Pub/Sub can resolve the
  // push endpoint (also the JWT `aud` claim Google signs PushMessage tokens for).
  PUBLIC_API_URL: z.string().min(1).optional(),
  // GCP service account used to re-register gmail watch().
  GOOGLE_WATCH_CLIENT_EMAIL: z.string().min(1).optional(),
  GOOGLE_WATCH_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_PUBSUB_TOPIC: z.string().min(1).optional(),
  // Connection-canary: a user whose Gmail connection gmailRequest() is
  // exercised daily to detect a silent break in the provider's proxy
  // transport. Skipped when unset.
  CONNECTION_CANARY_USER_ID: z.string().min(1).optional(),
  // Mail poll — fixed-cadence inbox sweep. Env override keeps the cost/latency
  // tradeoff tunable without a redeploy (default: every minute).
  MAIL_POLL_CRON: z.string().default("* * * * *"),
  FACT_DARK_LAUNCH: z.coerce.boolean().default(false),
  FACT_SWEEP_CRON: z.string().default("0 * * * *"),
  // Web Push: VAPID keys. Absent => push delivery is disabled and events
  // only reach users with a live socket (message stays in the thread otherwise).
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;
