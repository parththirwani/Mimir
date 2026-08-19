-- CreateTable
CREATE TABLE "ExtractedFact" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "embedding" vector(1536),
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceMessageId" TEXT,
    "supersedesId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractedFact_conversationId_status_idx" ON "ExtractedFact"("conversationId", "status");

-- CreateIndex
CREATE INDEX "ExtractedFact_conversationId_subject_idx" ON "ExtractedFact"("conversationId", "subject");

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ExtractedFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
