-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Plan_agentId_idx" ON "Plan"("agentId");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
