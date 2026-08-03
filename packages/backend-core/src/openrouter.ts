import { SpanStatusCode } from "@opentelemetry/api";
import { readFileSync } from "node:fs";
import type { ChatResult, LlmMessage } from "@mimir/shared-types";
import { getConfig } from "./config.js";
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

// ponytail: no streaming SDK — plain fetch, retry on 5xx/timeout (maxAttempts in
// model-config.json). Swap in an SDK when true streaming or per-call backpressure arrive.
export async function callOpenRouter(
  messages: LlmMessage[],
  options: { useCase?: string; model?: string; temperature?: number; maxTokens?: number } = {},
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
    const result = await attempt(messages, { model, temperature, maxTokens });
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
  params: { model: string; temperature: number; maxTokens: number },
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
  params: { model: string; temperature: number; maxTokens: number },
) {
  const { url, timeoutMs } = loadConfig().transport;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getConfig().OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: params.model, messages, max_tokens: params.maxTokens, temperature: params.temperature }),
      signal: ac.signal,
    });
  } catch {
    throw new OpenRouterError("OpenRouter request failed", 0, true);
  } finally {
    clearTimeout(timer);
  }

  const retriable = res.status >= 500 || res.status === 429;
  const body = await res.text();
  if (!res.ok) {
    throw new OpenRouterError(`OpenRouter error ${res.status}: ${body.slice(0, 500)}`, res.status, retriable);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new OpenRouterError("Malformed OpenRouter response", 502, false);
  }

  const content = (json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new OpenRouterError("OpenRouter response missing content", 502, false);
  }
  const usage = json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
  const promptTokens = usage.usage?.prompt_tokens ?? 0;
  const completionTokens = usage.usage?.completion_tokens ?? 0;
  const parsed = json as { id?: string; model?: string; choices?: [{ finish_reason?: string }] };
  return {
    content,
    model: params.model,
    actualModel: parsed.model,
    finishReason: parsed.choices?.[0]?.finish_reason,
    cachedTokens: usage.usage?.prompt_tokens_details?.cached_tokens,
    generationId: parsed.id,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: usage.usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

// ponytail: best-effort cost lookup; returns 0 on any failure. No retry —
// callers call this fire-and-forget. Swap to the OutboxEvent table if drops matter.
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