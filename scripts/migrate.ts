import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./intent-iteration/_env.js";

// Minimal forward-only migration applier. Reads prisma/migrations/*/migration.sql
// in lexical order, applies any not yet recorded in the _migrations table.
// Uses backend-core's existing pg-backed Prisma client, so no new driver dep.
//
// Run: bun scripts/migrate.ts    (needs DATABASE_URL)

loadEnv();
if (!process.env.DATABASE_URL) {
  console.log("SKIPPED (no DATABASE_URL)");
  process.exit(0);
}

const { getPrismaClient } = await import("@mimir/backend-core");
const prisma = getPrismaClient();

await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, appliedAt TIMESTAMP NOT NULL DEFAULT now())`);

const base = join(process.cwd(), "packages", "backend-core", "prisma", "migrations");
const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM _migrations`);
const applied = new Set(rows.map((r) => r.id));

// Only the migration dirs (skip migration_lock.toml and non-dirs).
const dirs = readdirSync(base)
  .filter((d) => /^\d/.test(d))
  .sort();

for (const dir of dirs) {
  const sqlPath = join(base, dir, "migration.sql");
  try {
    readFileSync(sqlPath, "utf8");
  } catch {
    continue;
  }
  if (applied.has(dir)) continue;
  const sql = readFileSync(sqlPath, "utf8");
  // Apply the SQL FIRST, then record it: if application fails midway the
  // migration is not marked applied, so a rerun retries cleanly.
  await prisma.$executeRawUnsafe(sql);
  await prisma.$executeRawUnsafe(`INSERT INTO _migrations (id) VALUES ($1)`, dir);
  console.log(`applied ${dir}`);
}

process.exit(0);