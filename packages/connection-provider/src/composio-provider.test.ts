import { beforeEach, mock } from "bun:test";
import { describe, expect, test } from "bun:test";

// Mock @composio/core BEFORE importing the provider so gmailRequest's
// proxyExecute call surfaces the exact params we pass and lets us drive status /
// thrown-error behavior.
interface ProxyCall {
  endpoint?: string;
  method?: string;
  body?: unknown;
  parameters?: { in: string; name: string; value: string }[];
  connectedAccountId?: string;
}
let proxyCall: ProxyCall | null = null;
let proxyStatus = 200;
let proxyData: unknown = { emailAddress: "me@example.com" };
let proxyThrow: Error | null = null;
mock.module("@composio/core", () => {
  class Composio {
    tools = {
      proxyExecute: async (body: ProxyCall) => {
        proxyCall = body;
        if (proxyThrow) throw proxyThrow;
        return { status: proxyStatus, data: proxyData };
      },
    };
  }
  return { Composio };
});

const { ComposioConnectionProvider } = await import("./composio-provider.js");
type Provider = InstanceType<typeof ComposioConnectionProvider>;

function store(initial: { connectionId: string; status: string } | null) {
  let row = initial;
  return {
    store: {
      async findFirst() {
        return row ? { id: "r1", ...row } : null;
      },
      async update({ data }: { data: { connectionId: string; status: string } }) {
        row = { connectionId: data.connectionId, status: data.status };
      },
      async create({ data }: { data: { connectionId: string; status: string } }) {
        row = { connectionId: data.connectionId, status: data.status };
      },
      async delete() {
        row = null;
      },
    },
    row: () => row,
  };
}

function provider(s: ReturnType<typeof store>): Provider {
  return new ComposioConnectionProvider({ apiKey: "k", authConfigId: "ac_x", store: s.store });
}

describe("ComposioConnectionProvider gmailRequest", () => {
  beforeEach(() => {
    proxyCall = null;
    proxyStatus = 200;
    proxyData = { emailAddress: "me@example.com" };
    proxyThrow = null;
  });

  test("resolves the connectionId from the store row and proxies the request", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    const res = await p.gmailRequest("user-1", "/gmail/v1/users/me/profile", {});
    expect(res).toEqual({ status: 200, data: { emailAddress: "me@example.com" } });
    expect(proxyCall).toMatchObject({ endpoint: "/gmail/v1/users/me/profile", method: "GET", connectedAccountId: "ca-1" });
  });

  test("repeated query params become repeated proxy parameters (metadataHeaders)", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    await p.gmailRequest("user-1", "/gmail/v1/users/me/messages/msg-1", {
      query: { format: "metadata", metadataHeaders: ["From", "Subject", "List-Unsubscribe", "In-Reply-To"] },
    });
    const headers = proxyCall!.parameters!.filter((x) => x.name === "metadataHeaders").map((x) => x.value);
    expect(headers).toEqual(["From", "Subject", "List-Unsubscribe", "In-Reply-To"]);
  });

  test("a scalar q param serializes as a single proxy parameter (search)", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    await p.gmailRequest("user-1", "/gmail/v1/users/me/messages", {
      query: { maxResults: 20, q: "from:openrouter" },
    });
    const q = proxyCall!.parameters!.filter((x) => x.name === "q");
    expect(q).toEqual([{ in: "query", name: "q", value: "from:openrouter" }]);
  });

  test("honours an explicit connectionId override (syncConnection heal probe)", async () => {
    const p = provider(store(null));
    await p.gmailRequest("user-1", "/gmail/v1/users/me/profile", { connectionId: "ca-found" });
    expect(proxyCall!.connectedAccountId).toBe("ca-found");
  });

  test("throws ConnectionError(not_connected) when no connection row and no override", async () => {
    const p = provider(store(null));
    await expect(p.gmailRequest("user-1", "/gmail/v1/users/me/profile")).rejects.toMatchObject({
      kind: "not_connected",
    });
  });

  test("maps a thrown Composio APIError (401) to ConnectionError(expired)", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    proxyThrow = Object.assign(new Error("unauthorized"), { status: 401 });
    await expect(p.gmailRequest("user-1", "/gmail/v1/users/me/profile")).rejects.toMatchObject({ kind: "expired" });
  });

  test("maps a thrown Composio APIError (404) to ConnectionError(not_connected)", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    proxyThrow = Object.assign(new Error("gone"), { status: 404 });
    await expect(p.gmailRequest("user-1", "/gmail/v1/users/me/profile")).rejects.toMatchObject({
      kind: "not_connected",
    });
  });

  test("maps a TOOL_AUTH_BadConnectedAccountState payload (422) to ConnectionError(expired)", async () => {
    const p = provider(store({ connectionId: "ca-1", status: "connected" }));
    const nested = JSON.stringify({
      error: {
        message: "Connected account is not in an ACTIVE state. Current status is \"EXPIRED\" but ACTIVE status is required for authorization.",
        code: 1706,
        slug: "TOOL_AUTH_BadConnectedAccountState",
        suggested_fix: "Status reason: Access revoked; Details: { \"error\": \"invalid_grant\", \"error_description\": \"Token has been expired or revoked.\" }",
      },
    });
    proxyThrow = Object.assign(new Error(`422 ${nested}`), { status: 422, code: 1706 });
    await expect(p.gmailRequest("user-1", "/gmail/v1/users/me/profile")).rejects.toMatchObject({ kind: "expired" });
  });
});

describe("ComposioConnectionProvider syncConnection", () => {
  beforeEach(() => {
    proxyCall = null;
    proxyStatus = 200;
    proxyData = { emailAddress: "me@example.com" };
    proxyThrow = null;
  });

  test("persists expired on a non-200 probe result", async () => {
    const s = store({ connectionId: "ca-1", status: "connected" });
    const p = provider(s);
    proxyStatus = 422;
    const ok = await p.syncConnection("user-1", "ca-1");
    expect(ok).toBe(false);
    expect(s.row()?.status).toBe("expired");
  });

  test("persists expired when the probe throws (dead/revoked token)", async () => {
    const s = store({ connectionId: "ca-1", status: "connected" });
    const p = provider(s);
    proxyThrow = Object.assign(new Error("unauthorized"), { status: 401 });
    const ok = await p.syncConnection("user-1", "ca-1");
    expect(ok).toBe(false);
    expect(s.row()?.status).toBe("expired");
  });

  test("heals a dead row back to connected when the probe succeeds", async () => {
    const s = store({ connectionId: "ca-1", status: "expired" });
    const p = provider(s);
    proxyStatus = 200;
    const ok = await p.syncConnection("user-1", "ca-1");
    expect(ok).toBe(true);
    expect(s.row()?.status).toBe("connected");
  });
});
