import { getLogger } from "./logger.js";
import { getPrismaClient } from "./prisma.js";

// Analytics is best-effort: a telemetry write must never fail the primary
// request (login, message). Log and swallow.
export async function trackEvent(userId: string, eventType: string, properties?: Record<string, unknown>) {
  try {
    await getPrismaClient().analyticsEvent.create({
      data: { userId, eventType, properties: (properties ?? {}) as object },
    });
  } catch (e) {
    getLogger().error({ err: e, eventType }, "analytics event write failed");
  }
}
