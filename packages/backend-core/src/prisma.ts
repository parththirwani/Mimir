import { PrismaPg } from "@prisma/adapter-pg";
import { getConfig } from "./config/config.js";
import { PrismaClient } from "./generated/prisma/client.js";

// Re-export the Prisma namespace (input types like Prisma.InputJsonValue) for
// consumers that write Json columns without importing the generated client.
export * as Prisma from "./generated/prisma/client.js";
export type { InputJsonValue } from "./generated/prisma/internal/prismaNamespace.js";

let client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: getConfig().DATABASE_URL });
    client = new PrismaClient({ adapter });
  }
  return client;
}
