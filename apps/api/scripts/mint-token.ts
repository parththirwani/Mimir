// One-off: mint an access token for a user (E2E chat re-run). Run from apps/api:
//   bun --env-file=../../.env scripts/mint-token.ts <userId>
import { getConfig } from "@mimir/backend-core";
import { signAccessToken } from "../src/auth/tokens.js";

const userId = process.argv[2];
if (!userId) throw new Error("usage: bun --env-file=../../.env scripts/mint-token.ts <userId>");
process.stdout.write(await signAccessToken(userId, getConfig().JWT_SECRET));
