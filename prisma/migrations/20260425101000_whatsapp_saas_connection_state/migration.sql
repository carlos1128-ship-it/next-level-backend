ALTER TABLE "WhatsappConnection"
  ADD COLUMN IF NOT EXISTS "instanceId" TEXT,
  ADD COLUMN IF NOT EXISTS "connectionState" TEXT NOT NULL DEFAULT 'close',
  ADD COLUMN IF NOT EXISTS "sessionGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "lastQrGeneratedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastConnectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastDisconnectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastEvolutionSyncAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "operationLockUntil" TIMESTAMP(3);

UPDATE "WhatsappConnection"
SET "status" = 'not_configured'
WHERE "status" = 'idle';

UPDATE "WhatsappConnection"
SET "connectionState" = COALESCE("lastEvolutionState", 'close')
WHERE "connectionState" = 'close'
  AND "lastEvolutionState" IS NOT NULL;
