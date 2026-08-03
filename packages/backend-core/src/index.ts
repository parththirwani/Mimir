export const version = "0.1.0";

import "./observability.js"; // side effect: starts OTel SDK + Sentry before instrumented modules load

export type { User, Message, Conversation } from "@mimir/shared-types";
export * from "./constants.js";
export { getConfig } from "./config.js";
export type { Config } from "./config.schema.js";
export { getPrismaClient } from "./prisma.js";
export { tracer } from "./observability.js";
export { logger, getLogger, runWithContext } from "./logger.js";
export { callOpenRouter, llmConfigFor, modelFor, fetchGenerationCost, NotConfiguredError, OpenRouterError } from "./openrouter.js";
export type { LlmUseCaseConfig } from "./openrouter.js";
export { trackEvent } from "./analytics.js";
