import { callOpenRouter } from "./openrouter.js";
import { loadPrompt } from "./prompts.js";
import { getLogger } from "./logger.js";
import { trackModelCall } from "./usage.js";

// The acknowledgment is what the user sees the instant a delegation is decided
// (agent spawn/retarget, email drafting, email send). It must be fast and must
// ALWAYS appear, so every kind has a hard fallback: the LLM varies the phrasing,
// a failure drops straight to the fallback instead of blocking the reply.
export type AckKind =
  | "draft"
  | "send"
  | "spawn"
  | "retarget"
  | "agent_draft_confirm"
  | "send_result"
  | "send_failed";

const ACK_SYSTEM = loadPrompt("ack.md");

export const ACK_FALLBACKS: Record<AckKind, string> = {
  draft: "Preparing your draft — one sec.",
  send: "Sending it now — I'll confirm here in a moment.",
  spawn: "Got it — I'm on it. I'll surface anything relevant here as it happens.",
  retarget: "Got it — I'm already on that. I'll keep you posted here.",
  agent_draft_confirm: "On it — I'll handle that now.",
  send_result: "Sent.",
  send_failed: "The email couldn't be sent right now.",
};

export interface GenerateAckOptions {
  /** What the assistant is about to do (or just did), so the line is specific. */
  context?: string;
  /** Override the default fallback (e.g. a result line that must carry facts). */
  fallback?: string;
  /** Attributed on the model call log (best-effort usage accounting). */
  userId?: string;
}

// Test seam: lets callers force the fallback path without mock.module (bun test
// runs every file in one process, so module mocks leak). Not part of the public
// surface — production callers omit it and get the real openrouter caller.
type AckLlmCaller = (messages: Parameters<typeof callOpenRouter>[0], options?: Parameters<typeof callOpenRouter>[1]) => ReturnType<typeof callOpenRouter>;

interface GenerateAckDeps {
  callOpenRouter?: AckLlmCaller;
}

export async function generateAck(kind: AckKind, opts: GenerateAckOptions = {}, deps: GenerateAckDeps = {}): Promise<string> {
  const caller = deps.callOpenRouter ?? callOpenRouter;
  const fallback = opts.fallback ?? ACK_FALLBACKS[kind];
  const userId = opts.userId ?? "";
  const userLine = opts.context ? `What's happening: ${opts.context}` : `Action kind: ${kind}`;
  try {
    const result = await caller(
      [
        { role: "system", content: ACK_SYSTEM },
        { role: "user", content: `${userLine}\nWrite the acknowledgment line.` },
      ],
      { useCase: "ack" },
    );
    const line = result.content.trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "").slice(0, 200);
    await trackModelCall({ userId, useCase: "ack", result });
    return line || fallback;
  } catch (e) {
    getLogger().warn({ err: e, kind }, "ack generation failed; using fallback");
    await trackModelCall({ userId, useCase: "ack", error: (e as Error)?.message ?? String(e) });
    return fallback;
  }
}
