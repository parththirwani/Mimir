export const version = "0.1.0";

export type { User, Message, Conversation } from "@mimir/shared-types";
export { getConfig } from "./config.js";
export type { Config } from "./config.schema.js";
export { getPrismaClient } from "./prisma.js";
