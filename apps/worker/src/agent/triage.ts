import { callOpenRouter, getLogger, loadPrompt, trackModelCall } from "@mimir/backend-core";
import type { LlmMessage } from "@mimir/shared-types";

// Triage classification for the unwatched-inbox surfacing (the monitor).
// Deliberately STRICTER than the async filter: nothing asked for this message
// to be watched, so the default bar is false — only a clear urgent/actionable
// signal surfaces. Uses its own cheap model key (triage_classification).
export interface TriageVerdict {
  surface: boolean;
  rationale: string;
  category: "actionable" | "fyi" | "noise";
  // True when the classifier itself failed; callers must NOT durable-claim the
  // item so a transient failure gets retried instead of silently dropping mail.
  error?: boolean;
}

const TRIAGE_SYSTEM = loadPrompt("filter_email.md");

// Shared parser for the prompt-shaped {surface, rationale, category} verdicts
// used by BOTH the async filter and triage. Safe default: a missing/incorrect
// surface or unparseable output does NOT surface. `ok` is false when the
// model's output wasn't parseable — callers that must not durable-claim on
// error branch.
export function parseSurfaceVerdict(raw: string): {
  surface: boolean;
  rationale: string;
  category: "actionable" | "fyi" | "noise";
  ok: boolean;
} {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
      surface?: unknown;
      rationale?: unknown;
      category?: unknown;
    };
    const surface = json.surface === true;
    const rationale = typeof json.rationale === "string" ? json.rationale : "";
    const category = json.category === "actionable" || json.category === "fyi" ? json.category : "noise";
    return { surface, rationale, category, ok: true };
  } catch {
    return { surface: false, rationale: "unparseable output", category: "noise", ok: false };
  }
}

export function parseTriage(raw: string): Omit<TriageVerdict, "error"> {
  const { surface, rationale, category } = parseSurfaceVerdict(raw);
  return { surface, rationale, category };
}

export async function triageVerdict(userId: string, content: string): Promise<TriageVerdict> {
  const messages: LlmMessage[] = [
    { role: "system", content: TRIAGE_SYSTEM },
    { role: "user", content },
  ];
  let result;
  try {
    result = await callOpenRouter(messages, { useCase: "triage_classification" });
  } catch (e) {
    getLogger().warn({ err: e }, "triage call failed; discarding result");
    await trackModelCall({ userId, useCase: "triage_classification", error: (e as Error)?.message ?? String(e) });
    return { surface: false, rationale: "triage unavailable", category: "noise", error: true };
  }
  await trackModelCall({ userId, useCase: "triage_classification", result });
  return parseTriage(result.content);
}
