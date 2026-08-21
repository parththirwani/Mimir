import { SpanStatusCode } from "@opentelemetry/api";
import { readFileSync } from "node:fs";
import type { ChatResult, LlmMessage } from "@mimir/shared-types";
import { getConfig } from "./config/config.js";
import { getLogger } from "./logger.js";
import { tracer } from "./observability.js";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED";
  constructor() {
    super("OPENROUTER_API_KEY is not configured");
  }
}

export interface LlmUseCaseConfig {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
}

interface TransportConfig {
  url: string;
  timeoutMs: number;
  maxAttempts: number;
}

interface LlmConfig {
  transport: TransportConfig;
  useCases: Record<string, LlmUseCaseConfig>;
  embeddings?: { model: string };
}

let cached: LlmConfig | null = null;

function loadConfig(): LlmConfig {
  if (cached) return cached;
  // model-config.json is gitignored (per-deployment override); fall back to the committed example.
  const cfgPath = new URL("../model-config.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      raw = readFileSync(new URL("../model-config.example.json", import.meta.url), "utf8");
    } else {
      throw e;
    }
  }
  cached = JSON.parse(raw) as LlmConfig;
  return cached;
}

export function modelFor(useCase: string): string {
  const entry = loadConfig().useCases[useCase];
  if (!entry) throw new Error(`No model configured for use-case "${useCase}"`);
  return entry.model;
}

export function llmConfigFor(useCase: string): LlmUseCaseConfig {
  const entry = loadConfig().useCases[useCase];
  if (!entry) throw new Error(`No model configured for use-case "${useCase}"`);
  return entry;
}

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface LlmTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

// OpenRouter/OpenAI uses snake_case `tool_calls`/`tool_call_id` on the wire; our
// internal LlmMessage uses camelCase (`toolCalls`/`toolCallId`). Map back before
// serializing so tool-loop turns (assistant tool_calls + tool results) are
// recognized by the API. All other fields pass through unchanged.
export function toWireMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.toolCalls) out.tool_calls = m.toolCalls;
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    return out;
  });
}

export type LlmCallOptions = {
  useCase?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LlmTool[];
  toolChoice?: ToolChoice;
};

export async function callOpenRouter(
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<ChatResult> {
  const apiKey = getConfig().OPENROUTER_API_KEY;
  if (!apiKey) throw new NotConfiguredError();

  const useCase = options.useCase ?? "chat_response";
  const cfg = llmConfigFor(useCase);
  const model = options.model ?? cfg.model;
  const temperature = options.temperature ?? cfg.temperature;
  const maxTokens = options.maxTokens ?? cfg.maxOutputTokens;
  const span = tracer.startSpan("openrouter chat.completions", { attributes: { "llm.model": model } });
  const startedAt = Date.now();

  try {
    const result = await attempt(messages, { model, temperature, maxTokens, tools: options.tools, toolChoice: options.toolChoice });
    span.setAttribute("llm.result.completion_tokens", result.usage.completionTokens);
    span.setAttribute("llm.result.prompt_tokens", result.usage.promptTokens);
    return { ...result, latencyMs: Date.now() - startedAt };
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw e;
  } finally {
    span.end();
  }
}

async function attempt(
  messages: LlmMessage[],
  params: { model: string; temperature: number; maxTokens: number; tools?: LlmTool[]; toolChoice?: ToolChoice },
) {
  const { maxAttempts } = loadConfig().transport;
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) getLogger().warn({ attempt: i }, "retrying openrouter call");
    try {
      return await singleCall(messages, params);
    } catch (e) {
      lastError = e;
      if (!(e instanceof OpenRouterError) || !e.retriable) throw e;
    }
  }
  throw lastError;
}

async function singleCall(
  messages: LlmMessage[],
  params: { model: string; temperature: number; maxTokens: number; tools?: LlmTool[]; toolChoice?: ToolChoice },
) {
  const { url, timeoutMs } = loadConfig().transport;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const body: Record<string, unknown> = {
    model: params.model,
    messages: toWireMessages(messages),
    max_tokens: params.maxTokens,
    temperature: params.temperature,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    if (params.toolChoice) body.tool_choice = params.toolChoice;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getConfig().OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch {
    throw new OpenRouterError("OpenRouter request failed", 0, true);
  } finally {
    clearTimeout(timer);
  }

  const retriable = res.status >= 500 || res.status === 429;
  const resBody = await res.text();
  if (!res.ok) {
    throw new OpenRouterError(`OpenRouter error ${res.status}: ${resBody.slice(0, 500)}`, res.status, retriable);
  }

  let json: unknown;
  try {
    json = JSON.parse(resBody);
  } catch {
    throw new OpenRouterError("Malformed OpenRouter response", 502, false);
  }

  const parsed = json as {
    id?: string;
    model?: string;
    choices?: [{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const message = parsed.choices?.[0]?.message;
  const content = message?.content ?? "";
  const toolCalls = message?.tool_calls;
  // A tool-only turn has no content (content is null) — that's valid, not an error.
  // Null content with NO tool call is a transient provider anomaly (an empty
  // completion, often finish_reason "length") — retriable so the retry loop gets
  // a second chance before callers fall back gracefully.
  if (message?.content === null && !toolCalls) {
    throw new OpenRouterError(
      `OpenRouter response missing content and tool_calls (finish_reason=${parsed.choices?.[0]?.finish_reason ?? "unknown"})`,
      502,
      true,
    );
  }
  const usage = parsed.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    content,
    model: params.model,
    actualModel: parsed.model,
    finishReason: parsed.choices?.[0]?.finish_reason,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
    generationId: parsed.id,
    toolCalls,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

export async function fetchGenerationCost(generationId: string): Promise<number> {
  const { url, timeoutMs } = loadConfig().transport;
  const apiKey = getConfig().OPENROUTER_API_KEY;
  if (!apiKey) return 0;
  try {
    const base = url.replace(/\/chat\/completions$/, "");
    const res = await fetch(`${base}/generation?id=${generationId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return 0;
    const json = (await res.json()) as { data?: { total_cost?: number } };
    const cost = json.data?.total_cost ?? 0;
    return cost > 0 ? Math.round(cost * 100) : 0;
  } catch {
    return 0;
  }
}

// OpenRouter's /embeddings endpoint — OpenAI-compatible. No retry beyond the
// single attempt; dedup treats a failed embed as "no match" upstream.
export async function callEmbeddings(text: string): Promise<number[]> {
  const apiKey = getConfig().OPENROUTER_API_KEY;
  if (!apiKey) throw new NotConfiguredError();
  const model = loadConfig().embeddings?.model;
  if (!model) throw new Error("No embedding model configured");
  const { timeoutMs } = loadConfig().transport;

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new OpenRouterError(`Embedding error ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status, true);
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) throw new OpenRouterError("Embedding response missing vector", 502, false);
  return embedding;
}