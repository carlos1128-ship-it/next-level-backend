ALTER TABLE "Customer"
ADD COLUMN "channel" TEXT,
ADD COLUMN "provider" "IntegrationProvider",
ADD COLUMN "externalCustomerId" TEXT,
ADD COLUMN "sourceConversationId" TEXT,
ADD COLUMN "sourceMessageId" TEXT,
ADD COLUMN "source" TEXT,
ADD COLUMN "interest" TEXT,
ADD COLUMN "objective" TEXT,
ADD COLUMN "desiredDate" TIMESTAMP(3),
ADD COLUMN "desiredTime" TEXT,
ADD COLUMN "status" TEXT,
ADD COLUMN "metadata" JSONB;

CREATE INDEX "Customer_companyId_phone_idx"
ON "Customer"("companyId", "phone");

CREATE INDEX "Customer_companyId_channel_updatedAt_idx"
ON "Customer"("companyId", "channel", "updatedAt");

CREATE TABLE "BusinessActionRequest" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "customerId" TEXT,
  "leadId" TEXT,
  "conversationId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "provider" "IntegrationProvider" NOT NULL,
  "customerExternalId" TEXT NOT NULL,
  "sourceMessageId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEEDS_INFO',
  "customerName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "requestedService" TEXT,
  "objective" TEXT,
  "desiredDate" TIMESTAMP(3),
  "desiredTime" TEXT,
  "notes" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessActionRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BusinessActionRequest"
ADD CONSTRAINT "BusinessActionRequest_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessActionRequest"
ADD CONSTRAINT "BusinessActionRequest_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BusinessActionRequest"
ADD CONSTRAINT "BusinessActionRequest_leadId_fkey"
FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BusinessActionRequest"
ADD CONSTRAINT "BusinessActionRequest_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "BusinessActionRequest_companyId_status_updatedAt_idx"
ON "BusinessActionRequest"("companyId", "status", "updatedAt");

CREATE INDEX "BusinessActionRequest_companyId_type_updatedAt_idx"
ON "BusinessActionRequest"("companyId", "type", "updatedAt");

CREATE INDEX "BusinessActionRequest_companyId_channel_updatedAt_idx"
ON "BusinessActionRequest"("companyId", "channel", "updatedAt");

CREATE INDEX "BusinessActionRequest_conversationId_updatedAt_idx"
ON "BusinessActionRequest"("conversationId", "updatedAt");

CREATE INDEX "BusinessActionRequest_customerId_idx"
ON "BusinessActionRequest"("customerId");

CREATE INDEX "BusinessActionRequest_leadId_idx"
ON "BusinessActionRequest"("leadId");

CREATE INDEX "BusinessActionRequest_sourceMessageId_idx"
ON "BusinessActionRequest"("sourceMessageId");
