-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trigger_agentId_enabled_idx" ON "Trigger"("agentId", "enabled");

-- CreateIndex
CREATE INDEX "Trigger_enabled_idx" ON "Trigger"("enabled");

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
