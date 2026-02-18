-- Add user ownership to sales for per-user filtering
ALTER TABLE "Sale" ADD COLUMN "userId" TEXT;

-- Indexes for user-scoped queries
CREATE INDEX "Sale_userId_idx" ON "Sale"("userId");
CREATE INDEX "Sale_userId_occurredAt_idx" ON "Sale"("userId", "occurredAt");

-- Foreign key to User (nullable to keep backward compatibility with existing rows)
ALTER TABLE "Sale"
ADD CONSTRAINT "Sale_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
