-- AlterTable
ALTER TABLE "question"
  ADD COLUMN IF NOT EXISTS "media_url" TEXT,
  ADD COLUMN IF NOT EXISTS "media_type" TEXT;
