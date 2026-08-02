import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

export const logger = pino();

const requestCtx = new AsyncLocalStorage<Record<string, string>>();

export function runWithContext(bindings: Record<string, string>, fn: () => void): void {
  requestCtx.run(bindings, fn);
}

export function getLogger(): pino.Logger {
  const ctx = requestCtx.getStore();
  return ctx ? logger.child(ctx) : logger;
}
