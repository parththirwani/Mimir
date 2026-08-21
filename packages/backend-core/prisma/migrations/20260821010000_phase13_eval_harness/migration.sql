-- 13.5 human-gated retrieval tuning proposal table
CREATE TABLE "RetrievalTuningProposal" (
    "id" TEXT NOT NULL,
    "param" TEXT NOT NULL,
    "oldValue" DOUBLE PRECISION NOT NULL,
    "newValue" DOUBLE PRECISION NOT NULL,
    "evidenceRunIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RetrievalTuningProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RetrievalTuningProposal_status_createdAt_idx" ON "RetrievalTuningProposal"("status", "createdAt");