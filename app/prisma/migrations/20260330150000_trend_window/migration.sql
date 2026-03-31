-- CreateEnum
CREATE TYPE "TrendWindow" AS ENUM ('H1', 'H6', 'H24');

-- AlterTable
ALTER TABLE "TrendTopic"
ADD COLUMN "windowType" "TrendWindow" NOT NULL DEFAULT 'H24';

-- DropIndex
DROP INDEX "TrendTopic_symbol_windowEnd_idx";

-- CreateIndex
CREATE INDEX "TrendTopic_symbol_windowType_windowEnd_idx" ON "TrendTopic"("symbol", "windowType", "windowEnd");
