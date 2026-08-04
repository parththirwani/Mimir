import { PrismaPg } from "@prisma/adapter-pg";
import { getConfig } from "./config/config.js";
import { PrismaClient } from "./generated/prisma/client.js";

let client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: getConfig().DATABASE_URL });
    client = new PrismaClient({ adapter });
  }
  return client;
}
