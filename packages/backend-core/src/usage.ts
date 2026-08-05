import type { ChatResult } from "@mimir/shared-types";
import { getLogger } from "./logger.js";
import { getPrismaClient } from "./prisma.js";
import { fetchGenerationCost } from "./openrouter.js";

const prisma = getPrismaClient();

// Usage accounting is best-effort: a telemetry write must never fail the
// primary path. Shared by the api (chat/classification) and the worker
// (agent_execution/agent_filter), so these live here rather than per-app.
export async function trackModelCall({
  userId,
  useCase,
  result,
  error,
}: {
  userId: string;
  useCase: string;
  result?: ChatResult;
  error?: string;
}): Promise<string | null> {
  try {
    const log = await prisma.modelCallLog.create({
      data: {
        userId,
        useCase,
        model: result?.model ?? "unknown",
        actualModel: result?.actualModel,
        tokensUsed: result?.usage?.totalTokens ?? 0,
        promptTokens: result?.usage?.promptTokens,
        completionTokens: result?.usage?.completionTokens,
        cachedTokens: result?.cachedTokens,
        finishReason: result?.finishReason ?? "error",
        generationId: result?.generationId,
        costCents: 0,
        latencyMs: result?.latencyMs ?? 0,
        success: !!result && !error,
      },
    });
    return log.id;
  } catch (e) {
    getLogger().error({ err: e }, "model call log write failed");
    return null;
  }
}

export function backfillCost(generationId: string, logId: string): void {
  void fetchGenerationCost(generationId).then((costCents) => {
    if (costCents > 0) {
      prisma.modelCallLog.update({ where: { id: logId }, data: { costCents } }).catch(() => {});
    }
  });
}

export async function rollDailyUsage(userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  try {
    await prisma.usageRecord.upsert({
      where: { userId_date: { userId, date: start } },
      create: { userId, date: start, tokensUsed: tokens },
      update: { tokensUsed: { increment: tokens } },
    });
  } catch (e) {
    getLogger().error({ err: e }, "usage rollup write failed");
  }
}
