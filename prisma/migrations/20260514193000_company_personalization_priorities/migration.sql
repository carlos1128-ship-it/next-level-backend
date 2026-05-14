ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "customBusinessDescription" TEXT;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "mainGoals" JSONB;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "priorityModules" JSONB;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "nonPriorityModules" JSONB;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "preferredDashboardFocus" TEXT;
