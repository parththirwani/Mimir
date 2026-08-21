// Seed one local dev user so there's something to log in as immediately.
// Idempotent: re-running upserts by email. Run: bun scripts/seed-dev.ts
import { getPrismaClient } from "@mimir/backend-core";

const email = process.env.SEED_EMAIL ?? "dev@mimir.local";
const password = process.env.SEED_PASSWORD ?? "dev-password";

const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });
const user = await getPrismaClient().user.upsert({
  where: { email },
  update: { passwordHash },
  create: { email, passwordHash },
});
console.log(`seeded user ${user.email} (${user.id})`);
