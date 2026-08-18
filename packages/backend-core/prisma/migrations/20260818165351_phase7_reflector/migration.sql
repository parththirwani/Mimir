-- CreateEnum
CREATE TYPE "AgentComplexity" AS ENUM ('simple', 'complex');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "complexity" "AgentComplexity" NOT NULL DEFAULT 'simple';

-- CreateTable
CREATE TABLE "ReflectionEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "feedback" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReflectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReflectionEvent_agentId_createdAt_idx" ON "ReflectionEvent"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReflectionEvent" ADD CONSTRAINT "ReflectionEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
