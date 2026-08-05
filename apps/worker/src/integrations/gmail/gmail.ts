import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, NangoConnectionProvider, ProviderError } from "@mimir/connection-provider";

const prisma = getPrismaClient();
const GMAIL_API = "https://gmail.googleapis.com";

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  // Signal headers for the importance filter: a List-Unsubscribe marks bulk
  // mailers, an In-Reply-To marks a personal reply within a thread.
  listUnsubscribe?: string;
  inReplyTo?: string;
}

export interface EntityData {
  provider: string;
  messages?: GmailMessage[];
  items?: unknown[];
}

// Real Gmail REST reads behind the mock's exact output shape, so executeAgent's
// LLM prompt path is untouched.
export async function fetchEntityData(userId: string, entity: string | null, taskDescription: string): Promise<EntityData> {
  const e = (entity ?? "").toLowerCase();
  if (!(e.includes("gmail") || /email|mail/i.test(taskDescription))) {
    return { provider: entity ?? "", items: [] };
  }
  const cfg = getConfig();
  const provider = new NangoConnectionProvider({
    secretKey: cfg.NANGO_SECRET_KEY,
    host: cfg.NANGO_BASE_URL,
    store: prisma.integrationConnection,
  });
  const token = await provider.getAccessToken(userId);
  return { provider: "gmail", messages: await fetchGmailMessages(token) };
}

// Split from fetchEntityData so the REST layer is unit-testable with a mocked
// fetch and a fake token — no live Nango/Google account required.
export async function fetchGmailMessages(token: string): Promise<GmailMessage[]> {
  const list = await gmailFetch<GmailListResponse>(token, "/gmail/v1/users/me/messages?maxResults=10");
  const messages: GmailMessage[] = [];
  for (const row of list.messages ?? []) {
    const detail = await gmailFetch<GmailDetailResponse>(
      token,
      `/gmail/v1/users/me/messages/${row.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=In-Reply-To`,
    );
    const listUnsubscribe = headerValue(detail.payload, "List-Unsubscribe");
    const inReplyTo = headerValue(detail.payload, "In-Reply-To");
    messages.push({
      id: row.id,
      from: headerValue(detail.payload, "From"),
      subject: headerValue(detail.payload, "Subject"),
      body: detail.snippet ?? "",
      receivedAt: toIso(detail.internalDate),
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
    });
  }
  return messages;
}

export interface GmailDraftMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
}

// Send path (interactive chat, draft-then-confirm): the email is created as a
// Gmail draft at proposal time so a cancel leaves it sitting in the user's
// Drafts folder; confirming sends that exact draft via drafts/send.
export async function getGmailProfile(token: string): Promise<string> {
  const profile = await gmailFetch<{ emailAddress?: string }>(token, "/gmail/v1/users/me/profile");
  if (!profile.emailAddress) throw new ProviderError("malformed_response", "gmail profile missing emailAddress");
  return profile.emailAddress;
}

export async function createGmailDraft(token: string, msg: GmailDraftMessage): Promise<{ id: string; messageId: string }> {
  const draft = await gmailFetch<{ id?: string; message?: { id?: string } }>(token, "/gmail/v1/users/me/drafts", {
    method: "POST",
    body: { message: { raw: Buffer.from(buildRawMessage(msg), "utf8").toString("base64url") } },
  });
  if (!draft.id || !draft.message?.id) throw new ProviderError("malformed_response", "gmail draft missing id");
  return { id: draft.id, messageId: draft.message.id };
}

export async function sendGmailDraft(token: string, draftId: string): Promise<string> {
  const sent = await gmailFetch<{ id?: string }>(token, "/gmail/v1/users/me/drafts/send", {
    method: "POST",
    body: { id: draftId },
  });
  if (!sent.id) throw new ProviderError("malformed_response", "gmail send missing message id");
  return sent.id;
}

// RFC 2822 raw message for Gmail. Subject uses RFC 2047 B-encoding when it
// carries non-ASCII; the body is base64 under a UTF-8 text/plain part so any
// charset survives the API round-trip.
export function buildRawMessage(msg: GmailDraftMessage): string {
  const header = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeSubject(msg.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  return `${header}\r\n\r\n${Buffer.from(msg.body, "utf8").toString("base64")}`;
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

// HTTP error mapping. ConnectionError is fail-fast (reconnect, no retry);
// ProviderError is rethrown into BullMQ's attempts:5 backoff.
interface GmailFetchOptions {
  method?: string;
  body?: unknown;
}

async function gmailFetch<T>(token: string, path: string, opts: GmailFetchOptions = {}): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new ConnectionError("expired", "gmail access token rejected");
  if (res.status === 429) throw new ProviderError("rate_limited", "gmail rate limited");
  if (res.status === 400) throw new ProviderError("validation_failed", "gmail rejected request");
  if (res.status >= 500) throw new ProviderError("provider_down", `gmail api ${res.status}`);
  if (!res.ok) throw new Error(`gmail api returned ${res.status}`);
  return res.json() as Promise<T>;
}

interface GmailListResponse {
  messages?: { id: string }[];
}

interface GmailDetailResponse {
  snippet?: string | null;
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

function headerValue(payload: { headers?: { name?: string; value?: string }[] } | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// internalDate is epoch millis; a garbage value shouldn't kill the whole run.
function toIso(internalDate: unknown): string {
  const n = Number(internalDate);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "";
}
