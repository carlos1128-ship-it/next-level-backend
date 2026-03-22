-- Add payload column to ApiLog
ALTER TABLE "ApiLog" ADD COLUMN IF NOT EXISTS "payload" JSONB;
