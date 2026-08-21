import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../intent-iteration/_env.js";

// Phase 13.5 apply step — manual, human-gated. Records status: applied on a
// pending proposal AND reflects the new value in model-config.json (under the
// retrieval block). A human runs this only after reviewing the pending proposal.
//
// Run with proposal ids:
//   bun scripts/eval/apply-proposal.ts <id> [<id>...]

loadEnv();
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.log("usage: bun scripts/eval/apply-proposal.ts <proposalId> [id...]");
  process.exit(0);
}

const { getPrismaClient } = await import("@mimir/backend-core");
const prisma = getPrismaClient();

const cfgPath = join(process.cwd(), "packages", "backend-core", "model-config.json");

for (const id of ids) {
  const p = await prisma.retrievalTuningProposal.findUnique({ where: { id } });
  if (!p) {
    console.log(`proposal ${id}: not found`);
    continue;
  }
  if (p.status !== "pending") {
    console.log(`proposal ${id}: status is ${p.status}, not pending — skipping`);
    continue;
  }

  const [cat, key] = p.param.split(".");
  if (!cat || !key) {
    console.log(`proposal ${id}: param "${p.param}" not parseable as category.key — marking rejected`);
    await prisma.retrievalTuningProposal.update({ where: { id }, data: { status: "rejected" } });
    continue;
  }

  try {
    const raw = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const retrieval = (cfg.retrieval ?? {}) as Record<string, Record<string, number>>;
    const block = retrieval[cat] ?? {};
    block[key] = p.newValue;
    retrieval[cat] = block;
    cfg.retrieval = retrieval;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e) {
    // model-config.json may be absent in dev (openrouter.ts falls back to the
    // committed example). Nothing was written — record as rejected, not applied.
    console.log(`proposal ${id}: could not write config (${String(e)}) — marked rejected`);
    await prisma.retrievalTuningProposal.update({ where: { id }, data: { status: "rejected" } });
    continue;
  }

  await prisma.retrievalTuningProposal.update({ where: { id }, data: { status: "applied", appliedAt: new Date() } });
  console.log(`proposal ${id}: applied ${p.param} = ${p.newValue} (was ${p.oldValue})`);
}

process.exit(0);