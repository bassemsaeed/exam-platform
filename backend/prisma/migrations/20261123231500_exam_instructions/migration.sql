-- AlterTable
ALTER TABLE "exam"
  ADD COLUMN IF NOT EXISTS "instructions_text" TEXT,
  ADD COLUMN IF NOT EXISTS "instructions_media_url" TEXT,
  ADD COLUMN IF NOT EXISTS "instructions_media_type" TEXT,
  ADD COLUMN IF NOT EXISTS "instructions_require_completion" BOOLEAN NOT NULL DEFAULT false;
