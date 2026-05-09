CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'FAILED',
  'DISPUTED',
  'LOST',
  'TRIAL'
);

CREATE TABLE "BillingPlan" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "level" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "features" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingPlanPrice" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "billingCycle" "BillingCycle" NOT NULL,
  "amountInCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "abacatepayProductId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPlanPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companyId" TEXT,
  "billingPlanId" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "billingCycle" "BillingCycle" NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "abacatepayCheckoutId" TEXT,
  "abacatepaySubscriptionId" TEXT,
  "abacatepayCustomerId" TEXT,
  "abacatepayExternalId" TEXT,
  "checkoutUrl" TEXT,
  "amountInCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "eventType" TEXT NOT NULL,
  "apiVersion" INTEGER,
  "devMode" BOOLEAN NOT NULL DEFAULT false,
  "rawPayload" JSONB NOT NULL,
  "processed" BOOLEAN NOT NULL DEFAULT false,
  "processingError" TEXT,
  "subscriptionId" TEXT,
  "abacatepayCheckoutId" TEXT,
  "abacatepaySubscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPlan_key_key" ON "BillingPlan"("key");
CREATE UNIQUE INDEX "BillingPlanPrice_planId_billingCycle_key" ON "BillingPlanPrice"("planId", "billingCycle");
CREATE INDEX "BillingPlanPrice_abacatepayProductId_idx" ON "BillingPlanPrice"("abacatepayProductId");
CREATE UNIQUE INDEX "Subscription_abacatepayExternalId_key" ON "Subscription"("abacatepayExternalId");
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");
CREATE INDEX "Subscription_companyId_idx" ON "Subscription"("companyId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
CREATE INDEX "Subscription_planKey_idx" ON "Subscription"("planKey");
CREATE INDEX "Subscription_abacatepayCheckoutId_idx" ON "Subscription"("abacatepayCheckoutId");
CREATE INDEX "Subscription_abacatepaySubscriptionId_idx" ON "Subscription"("abacatepaySubscriptionId");
CREATE UNIQUE INDEX "PaymentEvent_eventId_key" ON "PaymentEvent"("eventId");
CREATE INDEX "PaymentEvent_eventType_idx" ON "PaymentEvent"("eventType");
CREATE INDEX "PaymentEvent_processed_idx" ON "PaymentEvent"("processed");
CREATE INDEX "PaymentEvent_subscriptionId_idx" ON "PaymentEvent"("subscriptionId");
CREATE INDEX "PaymentEvent_abacatepayCheckoutId_idx" ON "PaymentEvent"("abacatepayCheckoutId");
CREATE INDEX "PaymentEvent_abacatepaySubscriptionId_idx" ON "PaymentEvent"("abacatepaySubscriptionId");

ALTER TABLE "BillingPlanPrice"
  ADD CONSTRAINT "BillingPlanPrice_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_billingPlanId_fkey"
  FOREIGN KEY ("billingPlanId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
