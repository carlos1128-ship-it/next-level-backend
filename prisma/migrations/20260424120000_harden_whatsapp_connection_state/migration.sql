ALTER TABLE "WhatsappConnection"
  ADD COLUMN "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "webhookLastConfiguredAt" TIMESTAMP(3),
  ADD COLUMN "webhookLastError" TEXT,
  ADD COLUMN "webhookConfigHash" TEXT,
  ADD COLUMN "userRequestedDisconnect" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastEvolutionState" TEXT,
  ADD COLUMN "lastConnectionEventAt" TIMESTAMP(3),
  ADD COLUMN "lastQrAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;
