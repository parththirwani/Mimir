-- 10.9 typed facts
ALTER TABLE "ExtractedFact" ADD COLUMN "subjectType" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "ExtractedFact" ADD COLUMN "factType" TEXT NOT NULL DEFAULT 'attribute';

-- 10.8 generated tsvector + GIN index for lexical retrieval
ALTER TABLE "ExtractedFact" ADD COLUMN "factSearch" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', "subject" || ' ' || "fact")) STORED;
CREATE INDEX "ExtractedFact_factSearch_idx" ON "ExtractedFact" USING GIN ("factSearch");

-- 10.6 fact relation graph
CREATE TABLE "FactRelation" (
    "id" TEXT NOT NULL,
    "sourceFactId" TEXT NOT NULL,
    "targetFactId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactRelation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FactRelation_sourceFactId_idx" ON "FactRelation"("sourceFactId");
CREATE INDEX "FactRelation_targetFactId_idx" ON "FactRelation"("targetFactId");

ALTER TABLE "FactRelation" ADD CONSTRAINT "FactRelation_sourceFactId_fkey" FOREIGN KEY ("sourceFactId") REFERENCES "ExtractedFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactRelation" ADD CONSTRAINT "FactRelation_targetFactId_fkey" FOREIGN KEY ("targetFactId") REFERENCES "ExtractedFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10.7 context snapshot columns on ModelCallLog
ALTER TABLE "ModelCallLog" ADD COLUMN "systemPromptHash" TEXT;
ALTER TABLE "ModelCallLog" ADD COLUMN "injectedBlocks" JSONB;
ALTER TABLE "ModelCallLog" ADD COLUMN "messageWindow" JSONB;