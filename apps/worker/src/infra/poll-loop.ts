import { getLogger } from "@mimir/backend-core";

// Shared poll loop for the DB-driven relays (4.4 outbox, 6.1.4 webhook): drain
// unprocessed rows every few seconds. Returns a stop handle.
export function pollLoop(drain: () => Promise<unknown>, label: string, intervalMs = 3000): () => void {
  let running = true;
  void (async () => {
    while (running) {
      try {
        await drain();
      } catch (e) {
        getLogger().error({ err: e }, `${label} relay tick failed`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return () => {
    running = false;
  };
}
