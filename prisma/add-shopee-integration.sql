-- Adiciona SHOPEE ao enum IntegrationProvider
ALTER TYPE "IntegrationProvider" ADD VALUE 'SHOPEE';

-- Adiciona campo refreshToken à tabela Integration
ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "refreshToken" TEXT;
