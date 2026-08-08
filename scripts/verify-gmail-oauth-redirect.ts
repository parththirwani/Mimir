// Verify which Composio callback URL lands in the Google OAuth authorization
// request. Drives the connect SPA in headless Chromium via the DevTools
// Protocol and sniffs the request to accounts.google.com, printing its
// redirect_uri. Exits 0 only if it matches the v3.1 callback. Run:
//   bun --env-file=.env scripts/verify-gmail-oauth-redirect.ts [auth_config_id]
import { Composio } from "@composio/core";
import { spawn } from "node:child_process";

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error("COMPOSIO_API_KEY must be set");
const authConfigId = process.argv[2] ?? process.env.COMPOSIO_GMAIL_AUTH_CONFIG;
if (!authConfigId) throw new Error("pass an auth config id or set COMPOSIO_GMAIL_AUTH_CONFIG");

const EXPECTED = "https://backend.composio.dev/api/v3.1/toolkits/auth/callback";
const port = 9000 + Math.floor(Math.random() * 1000);

const composio = new Composio({ apiKey });
const req = await composio.connectedAccounts.link(`verify-user-${Date.now()}`, authConfigId, {
  callbackUrl: "http://localhost:4000/api/v1/integrations/gmail/callback",
});
console.log(`connected account id: ${req.id}`);
console.log(`link: ${req.redirectUrl}`);

const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/mimir-cdp",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForJson(url: string): Promise<unknown> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error("chromium devtools did not come up");
}

const wsUrl = (await waitForJson(`http://127.0.0.1:${port}/json/version`)) as {
  webSocketDebuggerUrl: string;
};
const targets = (await waitForJson(`http://127.0.0.1:${port}/json/list`)) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
}>;
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("ws connect failed"));
});

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const outcome = new Promise<{ googleUrl: string | null; timeout: boolean }>((resolve) => {
  const timer = setTimeout(() => resolve({ googleUrl: null, timeout: true }), 60000);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      method?: string;
      params?: { request?: { url?: string } };
    };
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params?.request?.url ?? "";
      if (url.startsWith("https://accounts.google.com/")) {
        clearTimeout(timer);
        resolve({ googleUrl: url, timeout: false });
      }
    }
  };
});

try {
  await send("Network.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: req.redirectUrl });
  const { googleUrl, timeout } = await outcome;
  if (timeout || !googleUrl) throw new Error(`timed out before reaching accounts.google.com${timeout ? " (SPA did not resolve)" : ""}`);
  console.log(`GOOGLE AUTH URL: ${googleUrl}`);
  const redirectUri = decodeURIComponent(new URL(googleUrl).searchParams.get("redirect_uri") ?? "");
  console.log(`GOOGLE redirect_uri=${redirectUri}`);
  process.exit(redirectUri === EXPECTED ? 0 : 1);
} finally {
  chrome.kill();
}
