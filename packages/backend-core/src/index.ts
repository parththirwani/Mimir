export const version = "0.1.0";

import "./observability.js"; // side effect: starts OTel SDK + Sentry before instrumented modules load

export type { User, Message, Conversation } from "@mimir/shared-types";
export * from "./constants.js";
export { getConfig } from "./config/config.js";
export type { Config } from "./config/config.schema.js";
export { getPrismaClient, Prisma } from "./prisma.js";
export type { InputJsonValue } from "./prisma.js";
export { tracer } from "./observability.js";
export { logger, getLogger, runWithContext } from "./logger.js";
export { callOpenRouter, callEmbeddings, llmConfigFor, modelFor, fetchGenerationCost, NotConfiguredError, OpenRouterError, toWireMessages } from "./openrouter.js";
export type { LlmUseCaseConfig, LlmTool, ToolCall, ToolChoice, LlmCallOptions } from "./openrouter.js";
export { trackEvent } from "./analytics.js";
export { trackModelCall, backfillCost, rollDailyUsage } from "./usage.js";
export { searchActiveFacts, searchActiveFactsWithRelations } from "./facts.js";
export type { FactHit } from "./facts.js";
export { loadPrompt, chatSystemPrompt, executionSystemPrompt, oneShotSystemPrompt, frameResultForUser } from "./prompts.js";
export type { FrameResultOptions } from "./prompts.js";
export { generateAck, ACK_FALLBACKS } from "./ack.js";
export type { AckKind, GenerateAckOptions } from "./ack.js";
