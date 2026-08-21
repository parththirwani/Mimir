-- 13.7 production fact-extraction wiring: per-conversation extraction watermark.
-- NULL = nothing extracted yet (existing conversations backfill on first run);
-- advanced only on SUCCESSFUL extractFacts so a retry re-runs from the last good point.
ALTER TABLE "Conversation" ADD COLUMN "lastExtractedAt" TIMESTAMP(3);
