-- AlterEnum: add multi_select, short_answer, essay, matching, ordering to QuestionType
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'multi_select';
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'short_answer';
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'essay';
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'matching';
ALTER TYPE "QuestionType" ADD VALUE IF NOT EXISTS 'ordering';
