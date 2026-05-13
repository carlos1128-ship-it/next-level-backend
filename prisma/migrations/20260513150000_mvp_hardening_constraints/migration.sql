ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS "FinancialTransaction_userId_fkey";

ALTER TABLE "FinancialTransaction" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "FinancialTransaction"
  ADD CONSTRAINT "FinancialTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX IF EXISTS "Product_mlItemId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Product_companyId_marketplaceProvider_mlItemId_key"
  ON "Product"("companyId", "marketplaceProvider", "mlItemId");

DROP INDEX IF EXISTS "Conversation_companyId_contactNumber_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_companyId_provider_contactNumber_key"
  ON "Conversation"("companyId", "provider", "contactNumber");
