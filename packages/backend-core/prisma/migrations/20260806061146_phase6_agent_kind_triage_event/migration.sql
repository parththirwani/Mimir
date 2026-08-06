-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('task', 'monitor');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "kind" "AgentKind" NOT NULL DEFAULT 'task';

-- CreateTable
CREATE TABLE "TriageEvent" (
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageEvent_pkey" PRIMARY KEY ("connectionId","externalId")
);

-- CreateIndex
CREATE INDEX "TriageEvent_userId_idx" ON "TriageEvent"("userId");
