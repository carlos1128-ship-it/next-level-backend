-- AlterTable: campos opcionais para calculadora de margem (imposto + frete por unidade)
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tax" DECIMAL(12,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "shipping" DECIMAL(12,2);
