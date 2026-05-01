-- Formal AI usage tracking and plan limits.
CREATE TYPE "AIUsageFeature" AS ENUM (
  'chat_ia',
  'whatsapp_agent',
  'image_analysis',
  'audio_transcription',
  'web_search',
  'report_generation',
  'intelligent_import',
  'other'
);

CREATE TYPE "AIUsageProvider" AS ENUM (
  'gemini',
  'openai',
  'internal',
  'unknown'
);

CREATE TYPE "AIUsageStatus" AS ENUM (
  'success',
  'failed',
  'blocked'
);

CREATE TABLE "AIUsageLog" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT,
  "feature" "AIUsageFeature" NOT NULL,
  "provider" "AIUsageProvider" NOT NULL DEFAULT 'unknown',
  "model" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "requestCount" INTEGER NOT NULL DEFAULT 1,
  "estimatedCost" DECIMAL(12,6),
  "status" "AIUsageStatus" NOT NULL,
  "errorMessage" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AIUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AIUsageLimit" (
  "id" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "feature" "AIUsageFeature" NOT NULL,
  "monthlyRequestLimit" INTEGER,
  "monthlyTokenLimit" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AIUsageLimit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanyAIUsageMonthly" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "yearMonth" TEXT NOT NULL,
  "feature" "AIUsageFeature" NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "tokenCount" INTEGER NOT NULL DEFAULT 0,
  "estimatedCost" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CompanyAIUsageMonthly_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AIUsageLog_companyId_createdAt_idx" ON "AIUsageLog"("companyId", "createdAt");
CREATE INDEX "AIUsageLog_companyId_feature_createdAt_idx" ON "AIUsageLog"("companyId", "feature", "createdAt");
CREATE INDEX "AIUsageLog_userId_createdAt_idx" ON "AIUsageLog"("userId", "createdAt");
CREATE INDEX "AIUsageLog_status_createdAt_idx" ON "AIUsageLog"("status", "createdAt");
CREATE UNIQUE INDEX "AIUsageLimit_planKey_feature_key" ON "AIUsageLimit"("planKey", "feature");
CREATE INDEX "AIUsageLimit_planKey_idx" ON "AIUsageLimit"("planKey");
CREATE UNIQUE INDEX "CompanyAIUsageMonthly_companyId_yearMonth_feature_key" ON "CompanyAIUsageMonthly"("companyId", "yearMonth", "feature");
CREATE INDEX "CompanyAIUsageMonthly_companyId_yearMonth_idx" ON "CompanyAIUsageMonthly"("companyId", "yearMonth");
CREATE INDEX "CompanyAIUsageMonthly_feature_yearMonth_idx" ON "CompanyAIUsageMonthly"("feature", "yearMonth");

ALTER TABLE "AIUsageLog" ADD CONSTRAINT "AIUsageLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIUsageLog" ADD CONSTRAINT "AIUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompanyAIUsageMonthly" ADD CONSTRAINT "CompanyAIUsageMonthly_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
