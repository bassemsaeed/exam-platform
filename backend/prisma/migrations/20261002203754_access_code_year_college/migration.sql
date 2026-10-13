-- AlterTable
ALTER TABLE "exam" ADD COLUMN     "access_code_hash" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "academic_year" INTEGER,
ADD COLUMN     "college" TEXT;
