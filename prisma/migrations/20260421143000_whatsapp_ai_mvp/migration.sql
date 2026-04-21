-- MVP WhatsApp AI mantendo compatibilidade com os modelos legados.
ALTER TABLE "AgentConfig"
  ALTER COLUMN "welcomeMessage" SET DEFAULT '',
  ALTER COLUMN "instructions" SET DEFAULT '';

ALTER TABLE "AgentConfig"
  ADD COLUMN IF NOT EXISTS "systemPrompt" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "toneOfVoice" TEXT NOT NULL DEFAULT 'consultivo',
  ADD COLUMN IF NOT EXISTS "internetSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "speechToTextEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "imageUnderstandingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pauseForHuman" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "debounceSeconds" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "maxContextMessages" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "modelProvider" TEXT NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS "modelName" TEXT NOT NULL DEFAULT 'gpt-4o-mini';

UPDATE "AgentConfig"
SET
  "systemPrompt" = COALESCE(NULLIF("systemPrompt", ''), "instructions", ''),
  "toneOfVoice" = COALESCE(NULLIF("toneOfVoice", ''), "tone", 'consultivo'),
  "isEnabled" = COALESCE("isEnabled", "isOnline", false);

CREATE TABLE IF NOT EXISTS "WhatsappConnection" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'evolution',
  "instanceName" TEXT NOT NULL,
  "instanceToken" TEXT,
  "status" TEXT NOT NULL DEFAULT 'disconnected',
  "qrCode" TEXT,
  "pairingCode" TEXT,
  "phoneNumber" TEXT,
  "webhookUrl" TEXT,
  "lastConnectionAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsappConnection_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappConnection_companyId_key"
  ON "WhatsappConnection"("companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappConnection_instanceName_key"
  ON "WhatsappConnection"("instanceName");

CREATE INDEX IF NOT EXISTS "WhatsappConnection_companyId_status_idx"
  ON "WhatsappConnection"("companyId", "status");

CREATE INDEX IF NOT EXISTS "WhatsappConnection_status_updatedAt_idx"
  ON "WhatsappConnection"("status", "updatedAt");

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "remoteJid" TEXT,
  ADD COLUMN IF NOT EXISTS "botPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastMessagePreview" TEXT;

UPDATE "Conversation"
SET
  "remoteJid" = COALESCE("remoteJid", "contactNumber"),
  "botPaused" = COALESCE("botPaused", "isPaused", false)
WHERE "remoteJid" IS NULL OR "botPaused" IS NULL;

CREATE INDEX IF NOT EXISTS "Conversation_companyId_remoteJid_idx"
  ON "Conversation"("companyId", "remoteJid");

ALTER TABLE "Message"
  ALTER COLUMN "content" SET DEFAULT '',
  ALTER COLUMN "role" SET DEFAULT 'user';

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS "contentType" TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS "text" TEXT,
  ADD COLUMN IF NOT EXISTS "transcription" TEXT,
  ADD COLUMN IF NOT EXISTS "mediaUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "aiResponse" TEXT,
  ADD COLUMN IF NOT EXISTS "senderName" TEXT,
  ADD COLUMN IF NOT EXISTS "senderPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS "metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "rawPayload" JSONB,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Message" AS m
SET
  "companyId" = COALESCE(m."companyId", c."companyId"),
  "text" = COALESCE(m."text", NULLIF(m."content", '')),
  "direction" = CASE
    WHEN LOWER(COALESCE(m."role", '')) IN ('assistant', 'ai', 'bot') THEN 'outbound'
    ELSE COALESCE(m."direction", 'inbound')
  END,
  "createdAt" = COALESCE(m."createdAt", m."timestamp", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE(m."updatedAt", m."timestamp", CURRENT_TIMESTAMP)
FROM "Conversation" AS c
WHERE m."conversationId" = c."id";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'Message_companyId_fkey'
      AND table_name = 'Message'
  ) THEN
    ALTER TABLE "Message"
      ADD CONSTRAINT "Message_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Message_conversationId_externalMessageId_key"
  ON "Message"("conversationId", "externalMessageId");

CREATE INDEX IF NOT EXISTS "Message_companyId_createdAt_idx"
  ON "Message"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
  ON "Message"("conversationId", "createdAt");
