import { describe, expect, test } from "bun:test";

// Must be set before @mimir/backend-core is imported (validates env at load).
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "delivery-test-secret";
// No VAPID keys => push delivery is disabled, so the chain ends at "none".

const { deliverToUser } = await import("../infra/delivery.js");

describe("delivery decision (7.4)", () => {
  test("no live socket + push disabled => none (message persists in thread)", async () => {
    const channel = await deliverToUser("nobody-is-connected", "new_message", { conversationId: "c1" });
    expect(channel).toBe("none");
  });

  test("never falls back to email — there is no email path", async () => {
    const channel = await deliverToUser("another-user", "new_message", { content: "hi" });
    expect(channel).toBe("none");
  });
});
