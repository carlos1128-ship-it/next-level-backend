-- Company-level onboarding profile and module/sidebar personalization.
CREATE TABLE "CompanyProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "businessModel" TEXT,
    "mainGoal" TEXT,
    "salesChannel" TEXT,
    "companySize" TEXT,
    "monthlyRevenueRange" TEXT,
    "dataMaturity" TEXT,
    "usesPaidTraffic" BOOLEAN NOT NULL DEFAULT false,
    "hasPhysicalProducts" BOOLEAN NOT NULL DEFAULT false,
    "hasDigitalProducts" BOOLEAN NOT NULL DEFAULT false,
    "hasServices" BOOLEAN NOT NULL DEFAULT false,
    "usesWhatsAppForSales" BOOLEAN NOT NULL DEFAULT false,
    "usesMarketplace" BOOLEAN NOT NULL DEFAULT false,
    "hasSupportTeam" BOOLEAN NOT NULL DEFAULT false,
    "hasOperationalCosts" BOOLEAN NOT NULL DEFAULT false,
    "wantsAutomation" BOOLEAN NOT NULL DEFAULT false,
    "wantsMarketAnalysis" BOOLEAN NOT NULL DEFAULT false,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "onboardingSkipped" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanyModulePreference" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyModulePreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyProfile_companyId_key" ON "CompanyProfile"("companyId");
CREATE UNIQUE INDEX "CompanyModulePreference_companyId_moduleKey_key" ON "CompanyModulePreference"("companyId", "moduleKey");
CREATE INDEX "CompanyModulePreference_companyId_idx" ON "CompanyModulePreference"("companyId");

ALTER TABLE "CompanyProfile"
ADD CONSTRAINT "CompanyProfile_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanyModulePreference"
ADD CONSTRAINT "CompanyModulePreference_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
