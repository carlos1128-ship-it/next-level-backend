ALTER TABLE "Lead"
ADD COLUMN "email" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "channel" TEXT,
ADD COLUMN "provider" "IntegrationProvider",
ADD COLUMN "externalCustomerId" TEXT,
ADD COLUMN "sourceConversationId" TEXT,
ADD COLUMN "latestIntent" TEXT,
ADD COLUMN "actionStatus" TEXT,
ADD COLUMN "requestedService" TEXT,
ADD COLUMN "requestedDate" TIMESTAMP(3),
ADD COLUMN "requestedTime" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "metadata" JSONB;

CREATE INDEX "Lead_companyId_channel_updatedAt_idx"
ON "Lead"("companyId", "channel", "updatedAt");

CREATE INDEX "Lead_companyId_latestIntent_updatedAt_idx"
ON "Lead"("companyId", "latestIntent", "updatedAt");

CREATE TABLE "AppointmentRequest" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "leadId" TEXT,
  "channel" TEXT NOT NULL,
  "provider" "IntegrationProvider" NOT NULL,
  "customerExternalId" TEXT NOT NULL,
  "customerName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "intent" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEEDS_INFO',
  "requestedService" TEXT,
  "requestedDate" TIMESTAMP(3),
  "requestedTime" TEXT,
  "notes" TEXT,
  "sourceMessageId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AppointmentRequest"
ADD CONSTRAINT "AppointmentRequest_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentRequest"
ADD CONSTRAINT "AppointmentRequest_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentRequest"
ADD CONSTRAINT "AppointmentRequest_leadId_fkey"
FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AppointmentRequest_companyId_status_updatedAt_idx"
ON "AppointmentRequest"("companyId", "status", "updatedAt");

CREATE INDEX "AppointmentRequest_companyId_channel_updatedAt_idx"
ON "AppointmentRequest"("companyId", "channel", "updatedAt");

CREATE INDEX "AppointmentRequest_conversationId_updatedAt_idx"
ON "AppointmentRequest"("conversationId", "updatedAt");

CREATE INDEX "AppointmentRequest_leadId_idx"
ON "AppointmentRequest"("leadId");

CREATE INDEX "AppointmentRequest_sourceMessageId_idx"
ON "AppointmentRequest"("sourceMessageId");
