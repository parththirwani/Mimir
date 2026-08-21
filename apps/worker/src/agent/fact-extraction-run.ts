import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { extractFacts } from "./fact-extraction.js";

const prisma = getPrismaClient();

export interface FactRunResult {
  conversationId: string;
  trigger: "message" | "sweep";
  watermarkBefore: string | null;
  windowEnd: string;
  inserted: number;
  superseded: number;
  darkLaunch: boolean;
  durationMs: number;
}

export async function runExtractForConversation(
  conversationId: string,
  trigger: "message" | "sweep",
  windowEnd = new Date(),
): Promise<FactRunResult | null> {
  const darkLaunch = getConfig().FACT_DARK_LAUNCH;
  const startedAt = Date.now();

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, lastExtractedAt: true },
  });
  if (!conv) {
    getLogger().warn(
      { conversationId, trigger },
      "fact extraction: conversation not found",
    );
    return null;
  }
  const from = conv.lastExtractedAt ?? new Date(0);

  // No new messages since the watermark -> nothing to do (and advancing the
  // watermark would be a no-op anyway). Cheap guard to skip idle convs.
  const newest = await prisma.message.findFirst({
    where: { conversationId, createdAt: { lte: windowEnd } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const actualWindowEnd = newest?.createdAt ?? windowEnd;
  if (
    newest &&
    conv.lastExtractedAt &&
    actualWindowEnd <= conv.lastExtractedAt
  ) {
    getLogger().debug(
      { conversationId, trigger },
      "fact extraction: nothing new since watermark",
    );
    return null;
  }

  const res = await extractFacts(conversationId, from, actualWindowEnd, {
    write: !darkLaunch,
  });

  if (!darkLaunch) {
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [
          { lastExtractedAt: null },
          { lastExtractedAt: { lt: actualWindowEnd } },
        ],
      },
      data: { lastExtractedAt: actualWindowEnd },
    });
  }

  const result: FactRunResult = {
    conversationId,
    trigger,
    watermarkBefore: conv.lastExtractedAt
      ? conv.lastExtractedAt.toISOString()
      : null,
    windowEnd: actualWindowEnd.toISOString(),
    inserted: res.inserted,
    superseded: res.superseded,
    darkLaunch,
    durationMs: Date.now() - startedAt,
  };
  getLogger().info(
    { ...result },
    `fact extraction (${trigger}${darkLaunch ? ", dark-launch" : ""})`,
  );
  return result;
}

const STALE_AFTER_MS = 60 * 60 * 1000; // 1h

export async function runStaleFactExtractionSweep(
  limit = 50,
): Promise<FactRunResult[]> {
  const darkLaunch = getConfig().FACT_DARK_LAUNCH;
  const convs = await prisma.conversation.findMany({
    where: {
      messages: { some: { createdAt: { lte: new Date() } } },
    },
    select: { id: true, lastExtractedAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const out: FactRunResult[] = [];
  for (const c of convs) {
    const newest = await prisma.message.findFirst({
      where: { conversationId: c.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!newest) continue;
    // Candidate if: nothing extracted yet (backlog), OR the watermark lags too far.
    if (
      c.lastExtractedAt &&
      newest.createdAt.getTime() - c.lastExtractedAt.getTime() < STALE_AFTER_MS
    ) {
      continue;
    }
    const r = await runExtractForConversation(c.id, "sweep", newest.createdAt);
    if (r) out.push(r);
  }
  getLogger().info(
    { count: out.length, darkLaunch },
    "fact extraction stale sweep ran",
  );
  return out;
}
