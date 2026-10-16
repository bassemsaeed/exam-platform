CREATE TYPE "ExamPurpose" AS ENUM ('midterm', 'quiz');
ALTER TABLE "exam" ADD COLUMN IF NOT EXISTS "title" VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE "exam" ADD COLUMN IF NOT EXISTS "purpose" "ExamPurpose" NOT NULL DEFAULT 'quiz';
UPDATE "exam" SET "title" = LEFT((SELECT "name" FROM "subject" WHERE "subject"."id" = "exam"."subject_id"), 120) WHERE "title" = '';
UPDATE "exam" SET "purpose" = 'midterm' WHERE "type" = 'doctor_exam';
