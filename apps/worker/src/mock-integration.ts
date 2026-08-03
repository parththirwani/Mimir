// Plan 4.5/4.8: canned entity data stands in for real integrations until Phase 5
// swaps this for apps/mcp-gmail behind the ConnectionProvider. This module is the
// single swap point — keep the surface identical when the real provider lands.
export async function fetchEntityData(entity: string | null, taskDescription: string): Promise<unknown> {
  const e = (entity ?? "").toLowerCase();
  if (e.includes("gmail") || /email|mail/i.test(taskDescription)) {
    return {
      provider: "gmail",
      mock: true,
      messages: [
        {
          id: "mock-1",
          from: "Alice Johnson <alice@example.com>",
          subject: "Project update",
          body: "Hey, quick check-in on the design doc. Can you take a look before Friday?",
          receivedAt: new Date().toISOString(),
        },
        {
          id: "mock-2",
          from: "GitHub <notifications@github.com>",
          subject: "[mimir] PR #12: fix token refresh",
          body: "Changes have been requested on PR #12.",
          receivedAt: new Date(Date.now() - 3600_000).toISOString(),
        },
      ],
    };
  }
  return { provider: entity, mock: true, items: [] };
}
