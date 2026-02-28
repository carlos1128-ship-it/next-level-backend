-- AlterTable
ALTER TABLE "Company" ADD COLUMN "userId" TEXT;

-- AlterTable
ALTER TABLE "FinancialTransaction" ADD COLUMN "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Company_userId_idx" ON "Company"("userId");
