-- NEXT LEVEL AI business intelligence foundation.
CREATE TABLE "BusinessEvent" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "metadataJson" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BusinessEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiInsight" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "impact" TEXT,
  "recommendation" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "source" TEXT NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiInsight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiAlert" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "recommendation" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),

  CONSTRAINT "AiAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessMemory" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerSignal" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "customerId" TEXT,
  "source" TEXT NOT NULL,
  "signalType" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationAnalysis" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "customerId" TEXT,
  "intent" TEXT,
  "sentiment" TEXT,
  "productsMentioned" JSONB,
  "objections" JSONB,
  "buyingIntent" TEXT,
  "summary" TEXT NOT NULL,
  "recommendedAction" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiRecommendation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "expectedImpact" TEXT,
  "actionType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'suggested',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessEvent_companyId_occurredAt_idx" ON "BusinessEvent"("companyId", "occurredAt");
CREATE INDEX "BusinessEvent_companyId_source_type_idx" ON "BusinessEvent"("companyId", "source", "type");
CREATE INDEX "AiInsight_companyId_createdAt_idx" ON "AiInsight"("companyId", "createdAt");
CREATE INDEX "AiInsight_companyId_type_priority_idx" ON "AiInsight"("companyId", "type", "priority");
CREATE INDEX "AiAlert_companyId_status_createdAt_idx" ON "AiAlert"("companyId", "status", "createdAt");
CREATE INDEX "AiAlert_companyId_type_severity_idx" ON "AiAlert"("companyId", "type", "severity");
CREATE UNIQUE INDEX "BusinessMemory_companyId_key_key" ON "BusinessMemory"("companyId", "key");
CREATE INDEX "BusinessMemory_companyId_category_idx" ON "BusinessMemory"("companyId", "category");
CREATE INDEX "CustomerSignal_companyId_createdAt_idx" ON "CustomerSignal"("companyId", "createdAt");
CREATE INDEX "CustomerSignal_companyId_signalType_idx" ON "CustomerSignal"("companyId", "signalType");
CREATE INDEX "CustomerSignal_customerId_idx" ON "CustomerSignal"("customerId");
CREATE INDEX "ConversationAnalysis_companyId_createdAt_idx" ON "ConversationAnalysis"("companyId", "createdAt");
CREATE INDEX "ConversationAnalysis_companyId_conversationId_idx" ON "ConversationAnalysis"("companyId", "conversationId");
CREATE INDEX "ConversationAnalysis_companyId_buyingIntent_idx" ON "ConversationAnalysis"("companyId", "buyingIntent");
CREATE INDEX "AiRecommendation_companyId_status_createdAt_idx" ON "AiRecommendation"("companyId", "status", "createdAt");
CREATE INDEX "AiRecommendation_companyId_category_idx" ON "AiRecommendation"("companyId", "category");

ALTER TABLE "BusinessEvent" ADD CONSTRAINT "BusinessEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAlert" ADD CONSTRAINT "AiAlert_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessMemory" ADD CONSTRAINT "BusinessMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSignal" ADD CONSTRAINT "CustomerSignal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationAnalysis" ADD CONSTRAINT "ConversationAnalysis_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationAnalysis" ADD CONSTRAINT "ConversationAnalysis_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationAnalysis" ADD CONSTRAINT "ConversationAnalysis_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
