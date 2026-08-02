import { createRequire } from "node:module";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

function resolveAgentCore(fromDir: string): string {
  const requireFromDir = createRequire(path.join(fromDir, "noop.js"));
  return realpathSync(requireFromDir.resolve("@mimir/agent-core"));
}

const expected = path.join(root, "packages/agent-core/src/index.ts");
const api = resolveAgentCore(path.join(root, "apps/api"));
const worker = resolveAgentCore(path.join(root, "apps/worker"));

let failed = false;
const check = (ok: boolean, message: string) => {
  if (ok) {
    console.log(`ok: ${message}`);
  } else {
    failed = true;
    console.error(`FAIL: ${message}`);
  }
};

check(api === expected, `apps/api resolves @mimir/agent-core to ${expected}`);
check(worker === expected, `apps/worker resolves @mimir/agent-core to ${expected}`);
check(api === worker, "apps/api and apps/worker resolve the identical single copy");

const linkPaths = [
  "apps/api/node_modules/@mimir/agent-core",
  "apps/worker/node_modules/@mimir/agent-core",
];
for (const p of linkPaths) {
  const full = path.join(root, p);
  if (!existsSync(full)) {
    check(true, `no local copy at ${p} (hoisted to root)`);
    continue;
  }
  const isSymlink = lstatSync(full).isSymbolicLink();
  check(isSymlink, `${p} is a symlink, not a vendored copy`);
  check(
    isSymlink && realpathSync(full) === path.join(root, "packages/agent-core"),
    `${p} points at the single packages/agent-core`
  );
}

const vendoredPaths = ["apps/api/src/vendor", "apps/worker/src/vendor"];
for (const p of vendoredPaths) {
  check(!existsSync(path.join(root, p)), `no vendored copy at ${p}`);
}

check(existsSync(path.join(root, "packages/agent-core/src/index.ts")), "single source of truth exists at packages/agent-core/src");

process.exit(failed ? 1 : 0);
