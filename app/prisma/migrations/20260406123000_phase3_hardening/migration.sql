-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REPLAYED', 'DISMISSED');

-- AlterTable
ALTER TABLE "ContentDraft"
ADD COLUMN "disclosureVersion" TEXT NOT NULL DEFAULT 'v1';

-- CreateTable
CREATE TABLE "PublishDeadLetter" (
    "id" TEXT NOT NULL,
    "publishJobId" TEXT NOT NULL,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "PublishDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishDeadLetter_publishJobId_key" ON "PublishDeadLetter"("publishJobId");

-- CreateIndex
CREATE INDEX "PublishDeadLetter_status_movedAt_idx" ON "PublishDeadLetter"("status", "movedAt");

-- AddForeignKey
ALTER TABLE "PublishDeadLetter"
ADD CONSTRAINT "PublishDeadLetter_publishJobId_fkey"
FOREIGN KEY ("publishJobId") REFERENCES "PublishJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
