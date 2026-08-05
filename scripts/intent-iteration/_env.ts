import { readFileSync } from "node:fs";
import { join } from "node:path";

// The harness runs from the repo root (bun run classify). Load the gitignored
// .env so DATABASE_URL/REDIS_URL/JWT_SECRET/OPENROUTER_API_KEY are available
// before any @mimir/backend-core module validates config at import time.
export function loadEnv(): void {
  const p = join(process.cwd(), ".env");
  try {
    const text = readFileSync(p, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file — rely on already-exported environment variables.
  }
}
