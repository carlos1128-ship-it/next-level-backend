ALTER TABLE "CompanyProfile"
ADD COLUMN "originalBusinessDescription" TEXT,
ADD COLUMN "detectedBusinessType" TEXT,
ADD COLUMN "classificationConfidence" DOUBLE PRECISION;
