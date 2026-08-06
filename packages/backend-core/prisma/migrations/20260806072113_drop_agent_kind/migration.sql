/*
  Warnings:

  - You are about to drop the column `kind` on the `Agent` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "kind";

-- DropEnum
DROP TYPE "AgentKind";
