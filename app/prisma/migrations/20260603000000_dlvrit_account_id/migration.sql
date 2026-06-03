-- Add dlvr.it output account ID to AccountProfile.
-- Nullable: existing accounts are not broken; value is set via the Manual UI.
ALTER TABLE "AccountProfile" ADD COLUMN "dlvritAccountId" INTEGER;
