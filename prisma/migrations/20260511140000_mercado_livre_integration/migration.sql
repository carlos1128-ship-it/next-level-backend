-- Mercado Livre -> Next Level: OAuth, catalogo, pedidos, perguntas, avaliacoes e auditoria LGPD.
ALTER TYPE "SaleChannel" ADD VALUE IF NOT EXISTS 'mercadolivre';

ALTER TABLE "Sale"
  ADD COLUMN IF NOT EXISTS "externalId" TEXT,
  ADD COLUMN IF NOT EXISTS "metadataJson" JSONB;

ALTER TABLE "FinancialTransaction"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "externalId" TEXT,
  ADD COLUMN IF NOT EXISTS "metadataJson" JSONB;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "mlItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "marketplaceProvider" "IntegrationProvider",
  ADD COLUMN IF NOT EXISTS "marketplaceStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "marketplacePermalink" TEXT,
  ADD COLUMN IF NOT EXISTS "currencyId" TEXT,
  ADD COLUMN IF NOT EXISTS "availableQuantity" INTEGER,
  ADD COLUMN IF NOT EXISTS "soldQuantity" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastMarketplaceSyncAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Sale_companyId_channel_externalId_key"
  ON "Sale"("companyId", "channel", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "FinancialTransaction_companyId_source_externalId_key"
  ON "FinancialTransaction"("companyId", "source", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_mlItemId_key" ON "Product"("mlItemId");
CREATE INDEX IF NOT EXISTS "Product_companyId_marketplaceProvider_idx"
  ON "Product"("companyId", "marketplaceProvider");

CREATE TABLE IF NOT EXISTS "Stock" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "provider" "IntegrationProvider" NOT NULL DEFAULT 'MERCADOLIVRE',
  "externalId" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreOAuthToken" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT,
  "mlUserId" TEXT NOT NULL,
  "nickname" TEXT,
  "accessTokenEncrypted" TEXT NOT NULL,
  "refreshTokenEncrypted" TEXT NOT NULL,
  "tokenType" TEXT NOT NULL DEFAULT 'bearer',
  "scope" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "lastSyncAt" TIMESTAMP(3),
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreOAuthToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreOrder" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "mlOrderId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "buyerId" TEXT,
  "status" TEXT NOT NULL,
  "currencyId" TEXT,
  "totalAmount" DECIMAL(12,2) NOT NULL,
  "paidAmount" DECIMAL(12,2),
  "dateCreated" TIMESTAMP(3) NOT NULL,
  "dateClosed" TIMESTAMP(3),
  "saleId" TEXT,
  "financialTransactionId" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreOrderItem" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "mlItemId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(12,2) NOT NULL,
  "fullUnitPrice" DECIMAL(12,2),
  "currencyId" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreShipment" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "mlShipmentId" TEXT NOT NULL,
  "status" TEXT,
  "substatus" TEXT,
  "logisticType" TEXT,
  "trackingCode" TEXT,
  "receiverName" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreShipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreQuestion" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "productId" TEXT,
  "mlQuestionId" TEXT NOT NULL,
  "mlItemId" TEXT,
  "sellerId" TEXT,
  "status" TEXT,
  "question" TEXT NOT NULL,
  "answer" TEXT,
  "dateCreated" TIMESTAMP(3),
  "answerDateCreated" TIMESTAMP(3),
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreReview" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "orderId" TEXT,
  "mlReviewId" TEXT NOT NULL,
  "rating" INTEGER,
  "status" TEXT,
  "title" TEXT,
  "content" TEXT,
  "dateCreated" TIMESTAMP(3),
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MercadoLivreAnalytics" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "metricKey" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'mercadolivre',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MercadoLivreAnalytics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LGPDLog" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "provider" "IntegrationProvider",
  "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "subjectId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LGPDLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Stock_productId_key" ON "Stock"("productId");
CREATE INDEX IF NOT EXISTS "Stock_companyId_idx" ON "Stock"("companyId");
CREATE INDEX IF NOT EXISTS "Stock_provider_externalId_idx" ON "Stock"("provider", "externalId");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOAuthToken_companyId_key" ON "MercadoLivreOAuthToken"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOAuthToken_companyId_mlUserId_key" ON "MercadoLivreOAuthToken"("companyId", "mlUserId");
CREATE INDEX IF NOT EXISTS "MercadoLivreOAuthToken_mlUserId_idx" ON "MercadoLivreOAuthToken"("mlUserId");
CREATE INDEX IF NOT EXISTS "MercadoLivreOAuthToken_expiresAt_idx" ON "MercadoLivreOAuthToken"("expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOrder_mlOrderId_key" ON "MercadoLivreOrder"("mlOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOrder_saleId_key" ON "MercadoLivreOrder"("saleId");
CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOrder_financialTransactionId_key" ON "MercadoLivreOrder"("financialTransactionId");
CREATE INDEX IF NOT EXISTS "MercadoLivreOrder_companyId_dateCreated_idx" ON "MercadoLivreOrder"("companyId", "dateCreated");
CREATE INDEX IF NOT EXISTS "MercadoLivreOrder_companyId_status_idx" ON "MercadoLivreOrder"("companyId", "status");
CREATE INDEX IF NOT EXISTS "MercadoLivreOrder_sellerId_idx" ON "MercadoLivreOrder"("sellerId");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreOrderItem_orderId_mlItemId_key" ON "MercadoLivreOrderItem"("orderId", "mlItemId");
CREATE INDEX IF NOT EXISTS "MercadoLivreOrderItem_companyId_idx" ON "MercadoLivreOrderItem"("companyId");
CREATE INDEX IF NOT EXISTS "MercadoLivreOrderItem_mlItemId_idx" ON "MercadoLivreOrderItem"("mlItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreShipment_orderId_key" ON "MercadoLivreShipment"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreShipment_mlShipmentId_key" ON "MercadoLivreShipment"("mlShipmentId");
CREATE INDEX IF NOT EXISTS "MercadoLivreShipment_companyId_status_idx" ON "MercadoLivreShipment"("companyId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreQuestion_mlQuestionId_key" ON "MercadoLivreQuestion"("mlQuestionId");
CREATE INDEX IF NOT EXISTS "MercadoLivreQuestion_companyId_status_idx" ON "MercadoLivreQuestion"("companyId", "status");
CREATE INDEX IF NOT EXISTS "MercadoLivreQuestion_companyId_dateCreated_idx" ON "MercadoLivreQuestion"("companyId", "dateCreated");
CREATE INDEX IF NOT EXISTS "MercadoLivreQuestion_mlItemId_idx" ON "MercadoLivreQuestion"("mlItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreReview_mlReviewId_key" ON "MercadoLivreReview"("mlReviewId");
CREATE INDEX IF NOT EXISTS "MercadoLivreReview_companyId_dateCreated_idx" ON "MercadoLivreReview"("companyId", "dateCreated");
CREATE INDEX IF NOT EXISTS "MercadoLivreReview_companyId_rating_idx" ON "MercadoLivreReview"("companyId", "rating");

CREATE UNIQUE INDEX IF NOT EXISTS "MercadoLivreAnalytics_companyId_metricKey_periodStart_periodEnd_key"
  ON "MercadoLivreAnalytics"("companyId", "metricKey", "periodStart", "periodEnd");
CREATE INDEX IF NOT EXISTS "MercadoLivreAnalytics_companyId_metricKey_idx"
  ON "MercadoLivreAnalytics"("companyId", "metricKey");

CREATE INDEX IF NOT EXISTS "LGPDLog_companyId_createdAt_idx" ON "LGPDLog"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "LGPDLog_provider_action_createdAt_idx" ON "LGPDLog"("provider", "action", "createdAt");

ALTER TABLE "Stock" ADD CONSTRAINT "Stock_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOAuthToken" ADD CONSTRAINT "MercadoLivreOAuthToken_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOAuthToken" ADD CONSTRAINT "MercadoLivreOAuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrder" ADD CONSTRAINT "MercadoLivreOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrder" ADD CONSTRAINT "MercadoLivreOrder_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrder" ADD CONSTRAINT "MercadoLivreOrder_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrderItem" ADD CONSTRAINT "MercadoLivreOrderItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrderItem" ADD CONSTRAINT "MercadoLivreOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MercadoLivreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreOrderItem" ADD CONSTRAINT "MercadoLivreOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreShipment" ADD CONSTRAINT "MercadoLivreShipment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreShipment" ADD CONSTRAINT "MercadoLivreShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MercadoLivreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreQuestion" ADD CONSTRAINT "MercadoLivreQuestion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreQuestion" ADD CONSTRAINT "MercadoLivreQuestion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreReview" ADD CONSTRAINT "MercadoLivreReview_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreReview" ADD CONSTRAINT "MercadoLivreReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MercadoLivreOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MercadoLivreAnalytics" ADD CONSTRAINT "MercadoLivreAnalytics_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LGPDLog" ADD CONSTRAINT "LGPDLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
