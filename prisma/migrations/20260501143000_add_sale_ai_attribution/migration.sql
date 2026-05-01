-- CreateEnum
CREATE TYPE "SaleAIAttributionSource" AS ENUM ('WHATSAPP_AGENT', 'INSTAGRAM_AGENT', 'CHAT_IA', 'MANUAL_REVIEW', 'IMPORTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "SaleAIAttribution" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "conversationId" TEXT,
    "leadId" TEXT,
    "messageId" TEXT,
    "source" "SaleAIAttributionSource" NOT NULL DEFAULT 'WHATSAPP_AGENT',
    "attributedRevenue" DECIMAL(12,2) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "metadataJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleAIAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleAIAttribution_saleId_key" ON "SaleAIAttribution"("saleId");

-- CreateIndex
CREATE INDEX "SaleAIAttribution_companyId_occurredAt_idx" ON "SaleAIAttribution"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "SaleAIAttribution_companyId_source_occurredAt_idx" ON "SaleAIAttribution"("companyId", "source", "occurredAt");

-- CreateIndex
CREATE INDEX "SaleAIAttribution_conversationId_idx" ON "SaleAIAttribution"("conversationId");

-- CreateIndex
CREATE INDEX "SaleAIAttribution_leadId_idx" ON "SaleAIAttribution"("leadId");

-- CreateIndex
CREATE INDEX "SaleAIAttribution_messageId_idx" ON "SaleAIAttribution"("messageId");

-- AddForeignKey
ALTER TABLE "SaleAIAttribution" ADD CONSTRAINT "SaleAIAttribution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAIAttribution" ADD CONSTRAINT "SaleAIAttribution_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAIAttribution" ADD CONSTRAINT "SaleAIAttribution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAIAttribution" ADD CONSTRAINT "SaleAIAttribution_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleAIAttribution" ADD CONSTRAINT "SaleAIAttribution_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
