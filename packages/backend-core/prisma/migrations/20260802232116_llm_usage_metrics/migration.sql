-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "promptTokens" INTEGER;
