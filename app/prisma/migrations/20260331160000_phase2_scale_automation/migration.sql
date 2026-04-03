-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "AccountProfile"
ADD COLUMN "lastSelectedAt" TIMESTAMP(3),
ADD COLUMN "replacementNotes" TEXT,
ADD COLUMN "replacementRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TelegramGroupCandidate"
ADD COLUMN "discoveryMetadata" JSONB,
ADD COLUMN "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "throttleUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountCredentialsRef" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "username" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountCredentialsRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountHealthState" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "rollingSuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
    "softFailureCount" INTEGER NOT NULL DEFAULT 0,
    "restrictionCount" INTEGER NOT NULL DEFAULT 0,
    "lastOutcome" TEXT,
    "lastPublishedAt" TIMESTAMP(3),
    "lastRestrictedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountHealthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestrictionEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "restrictionType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestrictionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotationPolicy" (
    "id" TEXT NOT NULL,
    "platform" "AccountPlatform" NOT NULL,
    "perAccountQuota" INTEGER NOT NULL DEFAULT 4,
    "globalQuota" INTEGER NOT NULL DEFAULT 12,
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "minDelayMinutes" INTEGER NOT NULL DEFAULT 10,
    "maxDelayMinutes" INTEGER NOT NULL DEFAULT 45,
    "adaptiveCooldownMinutes" INTEGER NOT NULL DEFAULT 30,
    "duplicateSimilarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.82,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RotationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceConnectorState" (
    "id" TEXT NOT NULL,
    "source" "SourceType" NOT NULL,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "healthy" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnectorState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountCredentialsRef_accountId_key" ON "AccountCredentialsRef"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountHealthState_accountId_key" ON "AccountHealthState"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RotationPolicy_platform_key" ON "RotationPolicy"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnectorState_source_key" ON "SourceConnectorState"("source");

-- AddForeignKey
ALTER TABLE "AccountCredentialsRef" ADD CONSTRAINT "AccountCredentialsRef_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHealthState" ADD CONSTRAINT "AccountHealthState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestrictionEvent" ADD CONSTRAINT "RestrictionEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
