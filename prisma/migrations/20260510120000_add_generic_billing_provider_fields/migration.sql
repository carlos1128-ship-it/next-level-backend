ALTER TABLE "BillingPlanPrice"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "providerProductId" TEXT,
  ADD COLUMN "providerOfferId" TEXT,
  ADD COLUMN "providerCheckoutUrl" TEXT,
  ADD COLUMN "providerMetadata" JSONB;

ALTER TABLE "Subscription"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "providerCheckoutId" TEXT,
  ADD COLUMN "providerSubscriptionId" TEXT,
  ADD COLUMN "providerCustomerId" TEXT,
  ADD COLUMN "providerOrderId" TEXT,
  ADD COLUMN "providerOfferId" TEXT,
  ADD COLUMN "providerProductId" TEXT,
  ADD COLUMN "providerCheckoutUrl" TEXT,
  ADD COLUMN "providerRefId" TEXT,
  ADD COLUMN "providerSck" TEXT,
  ADD COLUMN "providerMetadata" JSONB;

ALTER TABLE "PaymentEvent"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "providerEventId" TEXT,
  ADD COLUMN "providerObjectId" TEXT,
  ADD COLUMN "providerOrderId" TEXT,
  ADD COLUMN "providerSubscriptionId" TEXT,
  ADD COLUMN "providerRawEventType" TEXT;

CREATE INDEX "BillingPlanPrice_provider_idx" ON "BillingPlanPrice"("provider");
CREATE INDEX "BillingPlanPrice_providerProductId_idx" ON "BillingPlanPrice"("providerProductId");
CREATE INDEX "BillingPlanPrice_providerOfferId_idx" ON "BillingPlanPrice"("providerOfferId");

CREATE INDEX "Subscription_provider_idx" ON "Subscription"("provider");
CREATE INDEX "Subscription_providerCheckoutId_idx" ON "Subscription"("providerCheckoutId");
CREATE INDEX "Subscription_providerSubscriptionId_idx" ON "Subscription"("providerSubscriptionId");
CREATE INDEX "Subscription_providerOrderId_idx" ON "Subscription"("providerOrderId");
CREATE INDEX "Subscription_providerOfferId_idx" ON "Subscription"("providerOfferId");
CREATE INDEX "Subscription_providerProductId_idx" ON "Subscription"("providerProductId");
CREATE INDEX "Subscription_providerSck_idx" ON "Subscription"("providerSck");

CREATE INDEX "PaymentEvent_provider_idx" ON "PaymentEvent"("provider");
CREATE INDEX "PaymentEvent_providerEventId_idx" ON "PaymentEvent"("providerEventId");
CREATE INDEX "PaymentEvent_providerObjectId_idx" ON "PaymentEvent"("providerObjectId");
CREATE INDEX "PaymentEvent_providerOrderId_idx" ON "PaymentEvent"("providerOrderId");
CREATE INDEX "PaymentEvent_providerSubscriptionId_idx" ON "PaymentEvent"("providerSubscriptionId");
