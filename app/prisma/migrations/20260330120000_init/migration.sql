-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('REDDIT', 'STOCKTWITS_SIGNAL', 'NEWS_API');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('EQUITY', 'CRYPTO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('GENERATED', 'AUTO_APPROVED', 'FLAGGED', 'REJECTED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "PublishPlatform" AS ENUM ('STOCKTWITS', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AccountPlatform" AS ENUM ('STOCKTWITS', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'DISABLED');

-- CreateTable
CREATE TABLE "SourceEvent" (
    "id" TEXT NOT NULL,
    "source" "SourceType" NOT NULL,
    "sourceUrl" TEXT,
    "externalId" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "symbols" TEXT[],
    "sentimentScore" DOUBLE PRECISION,
    "engagementScore" DOUBLE PRECISION,
    "author" TEXT,
    "rawPayload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendTopic" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "mentionCount" INTEGER NOT NULL,
    "averageSentiment" DOUBLE PRECISION,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentDraft" (
    "id" TEXT NOT NULL,
    "trendTopicId" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "disclaimer" TEXT NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "policyFlags" TEXT[],
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'GENERATED',
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountProfile" (
    "id" TEXT NOT NULL,
    "platform" "AccountPlatform" NOT NULL,
    "accountHandle" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountHealthEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramGroupCandidate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "inviteLink" TEXT,
    "chatId" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "joined" BOOLEAN NOT NULL DEFAULT false,
    "lastAttemptAt" TIMESTAMP(3),
    "statusNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramGroupCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishJob" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "platform" "PublishPlatform" NOT NULL,
    "accountId" TEXT,
    "targetRef" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "evidenceUri" TEXT,
    "externalPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "publishJobId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "responsePayload" JSONB,
    "evidenceUri" TEXT,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceEvent_source_occurredAt_idx" ON "SourceEvent"("source", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceEvent_source_externalId_key" ON "SourceEvent"("source", "externalId");

-- CreateIndex
CREATE INDEX "TrendTopic_symbol_windowEnd_idx" ON "TrendTopic"("symbol", "windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDraft_contentHash_key" ON "ContentDraft"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "AccountProfile_platform_accountHandle_key" ON "AccountProfile"("platform", "accountHandle");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramGroupCandidate_inviteLink_key" ON "TelegramGroupCandidate"("inviteLink");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramGroupCandidate_chatId_key" ON "TelegramGroupCandidate"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishJob_idempotencyKey_key" ON "PublishJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishJob_platform_status_scheduledAt_idx" ON "PublishJob"("platform", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_createdAt_idx" ON "AuditEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_trendTopicId_fkey" FOREIGN KEY ("trendTopicId") REFERENCES "TrendTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHealthEvent" ADD CONSTRAINT "AccountHealthEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_publishJobId_fkey" FOREIGN KEY ("publishJobId") REFERENCES "PublishJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

