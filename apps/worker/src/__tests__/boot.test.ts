import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Queue } from "bullmq";

// index.ts validates config at import time; env must be set before the spawned
// entrypoint (and this file's own imports) run.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "boot-test-secret";

const workerDir = path.resolve(import.meta.dir, "../..");

// The five repeatable schedulers index.ts registers on the shared
// agent-triggers queue. A subsequent suite run's agent-triggers worker could
// otherwise pick them up at a cron boundary and run real sweeps mid-test, so the
// boot test removes what it registers — leaving the registry as it found it.
const BOOT_SCHEDULERS = ["dormancy-sweep", "mail-poll-sweep", "trigger-tick", "watch-renewal", "connection-canary"];

describe("apps/worker full boot (entrypoint)", () => {
  test("index.ts boots cleanly with zero references to scheduleAdaptivePolling / scheduleReconciliation", async () => {
    // Source-level, deterministic check first: the boot module graph must not
    // mention the deleted scheduler functions or the deleted module at all.
    const queuesSrc = await Bun.file(path.join(workerDir, "src/infra/queues.ts")).text();
    const indexSrc = await Bun.file(path.join(workerDir, "src/index.ts")).text();
    for (const src of [queuesSrc, indexSrc]) {
      expect(src).not.toContain("scheduleAdaptivePolling");
      expect(src).not.toContain("scheduleReconciliation");
      expect(src).not.toContain("event-polling");
    }

    // Real boot: run the actual entrypoint as a subprocess. "mimir/worker ready"
    // is the LAST statement in index.ts, so its appearance proves the entire
    // module graph — including queues.ts — evaluated without a dangling symbol
    // (something tsc can miss inside strings / dynamic imports).
    const schedulerQ = new Queue("agent-triggers", {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    // Snapshot which schedulers already exist BEFORE spawning (a live dev worker
    // may own them); only clean up the ones this boot run adds, so the shared
    // scheduler registry is left as it was found.
    const preExistingSchedulers = new Set((await schedulerQ.getJobSchedulers()).map((s) => s.key));
    const proc = Bun.spawn({
      cmd: [process.execPath, "src/index.ts"],
      cwd: workerDir,
      env: { ...process.env, OTEL_SERVICE_NAME: "mimir-worker-boot-test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let stderr = "";
    // Read both pipes into strings as they stream (getReader, not for-await over
    // the stream, so tsc is happy) while the loop below polls for the ready line.
    const outRead = (async () => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += dec.decode(value, { stream: true });
      }
    })();
    const errRead = (async () => {
      const reader = proc.stderr.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stderr += dec.decode(value, { stream: true });
      }
    })();
    const deadline = Date.now() + 20_000;
    try {
      while (Date.now() < deadline && !stdout.includes("mimir/worker ready")) {
        await Bun.sleep(100);
      }
      expect(stdout, `boot failed; stderr=${stderr.trim()}`).toContain("mimir/worker ready");
      const combined = stdout + stderr;
      expect(combined).not.toContain("scheduleAdaptivePolling");
      expect(combined).not.toContain("scheduleReconciliation");
    } finally {
      proc.kill();
      await Promise.all([outRead, errRead, proc.exited]);
      try {
        for (const key of BOOT_SCHEDULERS) {
          if (!preExistingSchedulers.has(key)) await schedulerQ.removeJobScheduler(key);
        }
      } catch {
        // Best-effort cleanup of the scheduler registry.
      }
      await schedulerQ.close();
    }
  }, 30_000);
});