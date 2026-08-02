import { configSchema, type Config } from "./config.schema.js";

let cached: Config | null = null;

function parseConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.path.join("."));
    throw new Error(`Invalid environment config. Missing or malformed: ${issues.join(", ")}`);
  }
  return result.data;
}

export function getConfig(): Config {
  if (!cached) cached = parseConfig();
  return cached;
}
