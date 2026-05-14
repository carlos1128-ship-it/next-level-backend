ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAST_DUE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'UNPAID';

ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Company_stripeCustomerId_key" ON "Company"("stripeCustomerId");

ALTER TABLE "BillingPlanPrice" ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT;
ALTER TABLE "BillingPlanPrice" ADD COLUMN IF NOT EXISTS "stripeProductId" TEXT;
UPDATE "BillingPlanPrice"
SET "stripePriceId" = COALESCE("stripePriceId", "providerProductId")
WHERE "provider" = 'STRIPE';
DROP INDEX IF EXISTS "BillingPlanPrice_abacatepayProductId_idx";
ALTER TABLE "BillingPlanPrice" DROP COLUMN IF EXISTS "abacatepayProductId";
CREATE INDEX IF NOT EXISTS "BillingPlanPrice_stripePriceId_idx" ON "BillingPlanPrice"("stripePriceId");
CREATE INDEX IF NOT EXISTS "BillingPlanPrice_stripeProductId_idx" ON "BillingPlanPrice"("stripeProductId");

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeCheckoutSessionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "stripeStatus" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Subscription"
SET
  "stripeCustomerId" = COALESCE("stripeCustomerId", "providerCustomerId"),
  "stripeSubscriptionId" = COALESCE("stripeSubscriptionId", "providerSubscriptionId"),
  "stripeCheckoutSessionId" = COALESCE("stripeCheckoutSessionId", "providerCheckoutId"),
  "stripePriceId" = COALESCE("stripePriceId", "providerProductId")
WHERE "provider" = 'STRIPE';
ALTER TABLE "Subscription" ALTER COLUMN "source" SET DEFAULT 'STRIPE';
DROP INDEX IF EXISTS "Subscription_abacatepayExternalId_key";
DROP INDEX IF EXISTS "Subscription_abacatepayCheckoutId_idx";
DROP INDEX IF EXISTS "Subscription_abacatepaySubscriptionId_idx";
ALTER TABLE "Subscription" DROP COLUMN IF EXISTS "abacatepayCheckoutId";
ALTER TABLE "Subscription" DROP COLUMN IF EXISTS "abacatepaySubscriptionId";
ALTER TABLE "Subscription" DROP COLUMN IF EXISTS "abacatepayCustomerId";
ALTER TABLE "Subscription" DROP COLUMN IF EXISTS "abacatepayExternalId";
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_stripeCheckoutSessionId_key" ON "Subscription"("stripeCheckoutSessionId");
CREATE INDEX IF NOT EXISTS "Subscription_stripeCustomerId_idx" ON "Subscription"("stripeCustomerId");
CREATE INDEX IF NOT EXISTS "Subscription_stripeSubscriptionId_idx" ON "Subscription"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "Subscription_stripeCheckoutSessionId_idx" ON "Subscription"("stripeCheckoutSessionId");
CREATE INDEX IF NOT EXISTS "Subscription_stripePriceId_idx" ON "Subscription"("stripePriceId");

ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "stripeEventId" TEXT;
UPDATE "PaymentEvent"
SET "stripeEventId" = COALESCE("stripeEventId", "providerEventId")
WHERE "provider" = 'STRIPE';
DROP INDEX IF EXISTS "PaymentEvent_abacatepayCheckoutId_idx";
DROP INDEX IF EXISTS "PaymentEvent_abacatepaySubscriptionId_idx";
ALTER TABLE "PaymentEvent" DROP COLUMN IF EXISTS "abacatepayCheckoutId";
ALTER TABLE "PaymentEvent" DROP COLUMN IF EXISTS "abacatepaySubscriptionId";
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_stripeEventId_key" ON "PaymentEvent"("stripeEventId");
CREATE INDEX IF NOT EXISTS "PaymentEvent_stripeEventId_idx" ON "PaymentEvent"("stripeEventId");
