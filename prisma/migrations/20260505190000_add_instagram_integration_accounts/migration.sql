-- CreateTable
CREATE TABLE "IntegrationAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "igBusinessId" TEXT,
    "igUsername" TEXT,
    "pageId" TEXT,
    "pageName" TEXT,
    "pageAccessToken" TEXT,
    "tokenExpiry" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_companyId_provider_key" ON "IntegrationAccount"("companyId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_provider_igBusinessId_key" ON "IntegrationAccount"("provider", "igBusinessId");

-- CreateIndex
CREATE INDEX "IntegrationAccount_companyId_provider_idx" ON "IntegrationAccount"("companyId", "provider");

-- CreateIndex
CREATE INDEX "IntegrationAccount_provider_pageId_idx" ON "IntegrationAccount"("provider", "pageId");

-- CreateIndex
CREATE INDEX "IntegrationEvent_companyId_provider_createdAt_idx" ON "IntegrationEvent"("companyId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_provider_type_createdAt_idx" ON "IntegrationEvent"("provider", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "IntegrationAccount" ADD CONSTRAINT "IntegrationAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
