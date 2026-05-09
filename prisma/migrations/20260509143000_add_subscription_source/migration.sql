ALTER TABLE "Subscription"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ABACATEPAY',
  ADD COLUMN "notes" TEXT;

CREATE INDEX "Subscription_source_idx" ON "Subscription"("source");
