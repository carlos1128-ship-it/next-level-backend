ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "admin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AuditTrail"
ALTER COLUMN "companyId" DROP NOT NULL;

ALTER TABLE "AuditTrail"
DROP CONSTRAINT IF EXISTS "AuditTrail_companyId_fkey";

ALTER TABLE "AuditTrail"
ADD CONSTRAINT "AuditTrail_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ApiLog_statusCode_createdAt_idx"
ON "ApiLog"("statusCode", "createdAt");

CREATE INDEX IF NOT EXISTS "UsageQuota_createdAt_idx"
ON "UsageQuota"("createdAt");

CREATE INDEX IF NOT EXISTS "UsageQuota_updatedAt_idx"
ON "UsageQuota"("updatedAt");
