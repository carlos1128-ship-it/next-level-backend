ALTER TABLE "IntegrationAccount"
ADD COLUMN "instagramAccountId" TEXT,
ADD COLUMN "metadata" JSONB;

CREATE UNIQUE INDEX "IntegrationAccount_provider_instagramAccountId_key"
ON "IntegrationAccount"("provider", "instagramAccountId");

CREATE INDEX "IntegrationAccount_provider_instagramAccountId_idx"
ON "IntegrationAccount"("provider", "instagramAccountId");
