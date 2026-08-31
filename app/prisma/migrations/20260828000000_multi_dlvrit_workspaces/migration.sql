CREATE TABLE "DlvritWorkspace" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DlvritWorkspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DlvritWorkspace_email_key" ON "DlvritWorkspace"("email");

ALTER TABLE "AccountProfile" ADD COLUMN "dlvritWorkspaceId" TEXT;
CREATE INDEX "AccountProfile_dlvritWorkspaceId_idx" ON "AccountProfile"("dlvritWorkspaceId");
CREATE UNIQUE INDEX "AccountProfile_dlvritWorkspaceId_dlvritAccountId_key"
  ON "AccountProfile"("dlvritWorkspaceId", "dlvritAccountId");
ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_dlvritWorkspaceId_fkey"
  FOREIGN KEY ("dlvritWorkspaceId") REFERENCES "DlvritWorkspace"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
