ALTER TYPE "AIUsageFeature" ADD VALUE IF NOT EXISTS 'instagram_agent';

ALTER TABLE "IntegrationEvent" DROP CONSTRAINT IF EXISTS "IntegrationEvent_companyId_fkey";

ALTER TABLE "IntegrationEvent"
  ALTER COLUMN "companyId" DROP NOT NULL,
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN "processed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "processedAt" TIMESTAMP(3);

ALTER TABLE "IntegrationEvent"
  ADD CONSTRAINT "IntegrationEvent_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "IntegrationEvent_provider_externalId_key"
  ON "IntegrationEvent"("provider", "externalId");

ALTER TABLE "Conversation"
  ADD COLUMN "provider" "IntegrationProvider" NOT NULL DEFAULT 'WHATSAPP',
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN "externalThreadId" TEXT,
  ADD COLUMN "externalAccountId" TEXT;

CREATE INDEX "Conversation_companyId_provider_updatedAt_idx"
  ON "Conversation"("companyId", "provider", "updatedAt");

CREATE INDEX "Conversation_companyId_channel_updatedAt_idx"
  ON "Conversation"("companyId", "channel", "updatedAt");

CREATE INDEX "Conversation_companyId_provider_contactNumber_idx"
  ON "Conversation"("companyId", "provider", "contactNumber");

ALTER TABLE "Message"
  ADD COLUMN "provider" "IntegrationProvider" NOT NULL DEFAULT 'WHATSAPP',
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';

CREATE UNIQUE INDEX "Message_companyId_provider_externalMessageId_key"
  ON "Message"("companyId", "provider", "externalMessageId");

CREATE INDEX "Message_companyId_provider_createdAt_idx"
  ON "Message"("companyId", "provider", "createdAt");

CREATE INDEX "Message_companyId_channel_createdAt_idx"
  ON "Message"("companyId", "channel", "createdAt");
