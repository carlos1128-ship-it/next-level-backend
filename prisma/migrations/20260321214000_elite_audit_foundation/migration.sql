ALTER TABLE "Company"
ADD COLUMN IF NOT EXISTS "metaPhoneNumberId" TEXT,
ADD COLUMN IF NOT EXISTS "metaWabaId" TEXT;

ALTER TABLE "ApiLog"
ADD COLUMN IF NOT EXISTS "status" TEXT,
ADD COLUMN IF NOT EXISTS "provider" TEXT,
ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

DO $$
BEGIN
  CREATE TYPE "WebhookLogStatus" AS ENUM ('SUCCESS', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WebhookLog" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "provider" "IntegrationProvider" NOT NULL,
  "status" "WebhookLogStatus" NOT NULL DEFAULT 'SUCCESS',
  "message" TEXT,
  "eventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "WebhookLog"
  ADD CONSTRAINT "WebhookLog_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "WebhookLog_provider_status_createdAt_idx"
ON "WebhookLog"("provider", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "WebhookLog_companyId_provider_createdAt_idx"
ON "WebhookLog"("companyId", "provider", "createdAt");
