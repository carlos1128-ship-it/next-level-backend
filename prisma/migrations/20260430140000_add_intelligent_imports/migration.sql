CREATE TYPE "IntelligentImportInputType" AS ENUM ('IMAGE', 'PDF', 'CSV', 'TEXT', 'DOCUMENT');
CREATE TYPE "IntelligentImportStatus" AS ENUM ('UPLOADED', 'ANALYZING', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED', 'FAILED');
CREATE TYPE "IntelligentImportCategory" AS ENUM ('MARKETING', 'DELIVERY', 'MARKETPLACE', 'FINANCIAL', 'PRODUCTS', 'CUSTOMERS', 'MIXED', 'UNKNOWN');
CREATE TYPE "ImportedMetricUnit" AS ENUM ('CURRENCY', 'PERCENTAGE', 'COUNT', 'RATIO', 'TEXT');
CREATE TYPE "ImportedMetricSource" AS ENUM ('AI_IMPORT', 'CSV_IMPORT', 'MANUAL_TEXT', 'SCREENSHOT', 'PDF');
CREATE TYPE "ImportedMetricStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED');
CREATE TYPE "ImportedEntityType" AS ENUM ('PRODUCT', 'CUSTOMER', 'ORDER', 'ORDER_ITEM', 'CAMPAIGN', 'AD', 'COST', 'UNKNOWN');
CREATE TYPE "ImportedEntityStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED');

CREATE TABLE "IntelligentImport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inputType" "IntelligentImportInputType" NOT NULL,
    "fileName" TEXT,
    "fileMimeType" TEXT,
    "fileSize" INTEGER,
    "fileUrl" TEXT,
    "storageKey" TEXT,
    "pastedText" TEXT,
    "rawContentText" TEXT,
    "previewJson" JSONB,
    "expectedCategory" TEXT,
    "detectedCategory" "IntelligentImportCategory",
    "detectedPlatform" TEXT,
    "detectedPeriodStart" TIMESTAMP(3),
    "detectedPeriodEnd" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "IntelligentImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "aiSummary" TEXT,
    "extractedJson" JSONB,
    "warningsJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "IntelligentImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportedMetric" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "unit" "ImportedMetricUnit" NOT NULL,
    "currency" TEXT DEFAULT 'BRL',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "source" "ImportedMetricSource" NOT NULL,
    "platform" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "ImportedMetricStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportedEntity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "entityType" "ImportedEntityType" NOT NULL,
    "normalizedJson" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "ImportedEntityStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedEntity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntelligentImport_companyId_createdAt_idx" ON "IntelligentImport"("companyId", "createdAt");
CREATE INDEX "IntelligentImport_companyId_status_createdAt_idx" ON "IntelligentImport"("companyId", "status", "createdAt");
CREATE INDEX "IntelligentImport_companyId_detectedCategory_idx" ON "IntelligentImport"("companyId", "detectedCategory");

CREATE INDEX "ImportedMetric_companyId_status_createdAt_idx" ON "ImportedMetric"("companyId", "status", "createdAt");
CREATE INDEX "ImportedMetric_companyId_metricKey_status_idx" ON "ImportedMetric"("companyId", "metricKey", "status");
CREATE INDEX "ImportedMetric_importId_idx" ON "ImportedMetric"("importId");

CREATE INDEX "ImportedEntity_companyId_status_createdAt_idx" ON "ImportedEntity"("companyId", "status", "createdAt");
CREATE INDEX "ImportedEntity_companyId_entityType_status_idx" ON "ImportedEntity"("companyId", "entityType", "status");
CREATE INDEX "ImportedEntity_importId_idx" ON "ImportedEntity"("importId");

ALTER TABLE "IntelligentImport" ADD CONSTRAINT "IntelligentImport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntelligentImport" ADD CONSTRAINT "IntelligentImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedMetric" ADD CONSTRAINT "ImportedMetric_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedMetric" ADD CONSTRAINT "ImportedMetric_importId_fkey" FOREIGN KEY ("importId") REFERENCES "IntelligentImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedEntity" ADD CONSTRAINT "ImportedEntity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedEntity" ADD CONSTRAINT "ImportedEntity_importId_fkey" FOREIGN KEY ("importId") REFERENCES "IntelligentImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
