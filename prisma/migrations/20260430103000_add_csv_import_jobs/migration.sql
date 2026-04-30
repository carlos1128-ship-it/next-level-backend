-- CreateEnum
CREATE TYPE "CsvImportDataType" AS ENUM ('SALES', 'PRODUCTS', 'CUSTOMERS', 'COSTS', 'AD_SPEND', 'ORDERS');

-- CreateEnum
CREATE TYPE "CsvImportStatus" AS ENUM ('UPLOADED', 'MAPPED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "CsvImportJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dataType" "CsvImportDataType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "CsvImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "mappingJson" JSONB,
    "previewRowsJson" JSONB,
    "rawCsvText" TEXT,
    "errorJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CsvImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CsvImportRowError" (
    "id" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "rawRowJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CsvImportRowError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CsvImportJob_companyId_createdAt_idx" ON "CsvImportJob"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CsvImportJob_companyId_status_idx" ON "CsvImportJob"("companyId", "status");

-- CreateIndex
CREATE INDEX "CsvImportRowError_importJobId_idx" ON "CsvImportRowError"("importJobId");

-- CreateIndex
CREATE INDEX "CsvImportRowError_importJobId_rowNumber_idx" ON "CsvImportRowError"("importJobId", "rowNumber");

-- AddForeignKey
ALTER TABLE "CsvImportJob" ADD CONSTRAINT "CsvImportJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsvImportRowError" ADD CONSTRAINT "CsvImportRowError_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "CsvImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
