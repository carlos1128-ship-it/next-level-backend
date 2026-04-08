-- Adiciona colunas whatsappSessionName e whatsappWid na tabela Company
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "whatsappSessionName" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "whatsappWid" TEXT;

-- Limpa os campos para garantir que não há sessões zumbis
UPDATE "Company" SET "whatsappSessionName" = NULL;
UPDATE "Company" SET "whatsappWid" = NULL;
