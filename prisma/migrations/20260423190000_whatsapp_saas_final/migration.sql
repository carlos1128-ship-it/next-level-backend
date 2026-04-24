-- Fecha o contrato SaaS WhatsApp AI sem remover dados legados.
ALTER TABLE "AgentConfig"
  ADD COLUMN IF NOT EXISTS "companyDescription" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "splitRepliesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "messageBufferEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "AgentConfig" AS a
SET "companyDescription" = COALESCE(NULLIF(a."companyDescription", ''), c."description", '')
FROM "Company" AS c
WHERE a."companyId" = c."id";

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "whatsappConnectionId" TEXT;

UPDATE "Conversation" AS c
SET "whatsappConnectionId" = wc."id"
FROM "WhatsappConnection" AS wc
WHERE c."companyId" = wc."companyId"
  AND c."whatsappConnectionId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Conversation_whatsappConnectionId_fkey'
  ) THEN
    ALTER TABLE "Conversation"
      ADD CONSTRAINT "Conversation_whatsappConnectionId_fkey"
      FOREIGN KEY ("whatsappConnectionId") REFERENCES "WhatsappConnection"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Conversation_whatsappConnectionId_idx"
  ON "Conversation"("whatsappConnectionId");

UPDATE "Message" AS m
SET "companyId" = c."companyId"
FROM "Conversation" AS c
WHERE m."conversationId" = c."id"
  AND m."companyId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Message" WHERE "companyId" IS NULL) THEN
    RAISE EXCEPTION 'Existem mensagens sem companyId e sem conversa valida. Corrija antes de aplicar esta migration.';
  END IF;
END $$;

ALTER TABLE "Message"
  ALTER COLUMN "companyId" SET NOT NULL;
