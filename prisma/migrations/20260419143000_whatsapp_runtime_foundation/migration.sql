DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappInstanceStatus') THEN
    CREATE TYPE "WhatsappInstanceStatus" AS ENUM (
      'DISCONNECTED',
      'CONNECTING',
      'QR_READY',
      'CONNECTED',
      'ERROR'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WhatsappMessageProcessStatus') THEN
    CREATE TYPE "WhatsappMessageProcessStatus" AS ENUM (
      'PENDING',
      'PROCESSING',
      'PROCESSED',
      'FAILED',
      'IGNORED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "WhatsappInstance" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "instanceName" TEXT NOT NULL,
  "webhookTokenHash" TEXT NOT NULL,
  "status" "WhatsappInstanceStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "connectionState" TEXT NOT NULL DEFAULT 'close',
  "qrCode" TEXT,
  "pairingCode" TEXT,
  "phoneNumber" TEXT,
  "lastConnectionAt" TIMESTAMP(3),
  "lastWebhookAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappInstance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsappInstance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappInstance_companyId_key" ON "WhatsappInstance"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappInstance_instanceName_key" ON "WhatsappInstance"("instanceName");
CREATE INDEX IF NOT EXISTS "WhatsappInstance_status_updatedAt_idx" ON "WhatsappInstance"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "WhatsappMessageEvent" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "externalMessageId" TEXT NOT NULL,
  "remoteJid" TEXT NOT NULL,
  "remoteNumber" TEXT NOT NULL,
  "pushName" TEXT,
  "messageType" TEXT,
  "text" TEXT,
  "fromMe" BOOLEAN NOT NULL DEFAULT false,
  "eventName" TEXT NOT NULL,
  "messageTimestamp" TIMESTAMP(3),
  "status" "WhatsappMessageProcessStatus" NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "rawPayload" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappMessageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsappMessageEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WhatsappMessageEvent_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappMessageEvent_companyId_externalMessageId_key"
  ON "WhatsappMessageEvent"("companyId", "externalMessageId");
CREATE INDEX IF NOT EXISTS "WhatsappMessageEvent_companyId_status_createdAt_idx"
  ON "WhatsappMessageEvent"("companyId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "WhatsappMessageEvent_companyId_remoteNumber_createdAt_idx"
  ON "WhatsappMessageEvent"("companyId", "remoteNumber", "createdAt");
CREATE INDEX IF NOT EXISTS "WhatsappMessageEvent_instanceId_createdAt_idx"
  ON "WhatsappMessageEvent"("instanceId", "createdAt");
