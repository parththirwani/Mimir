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
  SENTRY_DSN: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
  NODE_ENV: z.string().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;
