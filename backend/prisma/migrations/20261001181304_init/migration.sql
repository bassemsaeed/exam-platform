-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'doctor', 'ta', 'student');

-- CreateEnum
CREATE TYPE "QuestionOwner" AS ENUM ('doctor', 'ta_shared');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('mcq', 'true_false');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('easy', 'medium', 'hard');

-- CreateEnum
CREATE TYPE "ExamType" AS ENUM ('doctor_exam', 'ta_quiz');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'locked', 'closed');

-- CreateEnum
CREATE TYPE "TargetScope" AS ENUM ('subject', 'sections', 'student_list');

-- CreateEnum
CREATE TYPE "StudentExamStatus" AS ENUM ('not_started', 'in_progress', 'submitted', 'auto_submitted');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('users', 'questions');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('dry_run', 'committed', 'expired');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "username" TEXT,
    "role" "Role" NOT NULL DEFAULT 'student',
    "can_change_password" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "department_id" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "department_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "student_id" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("student_id","subject_id","term_id")
);

-- CreateTable
CREATE TABLE "doctor_assignment" (
    "doctor_id" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,

    CONSTRAINT "doctor_assignment_pkey" PRIMARY KEY ("doctor_id","subject_id","term_id")
);

-- CreateTable
CREATE TABLE "section" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "ta_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_membership" (
    "student_id" TEXT NOT NULL,
    "section_id" UUID NOT NULL,

    CONSTRAINT "section_membership_pkey" PRIMARY KEY ("student_id","section_id")
);

-- CreateTable
CREATE TABLE "question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_id" UUID NOT NULL,
    "owner_type" "QuestionOwner" NOT NULL,
    "doctor_id" TEXT,
    "added_by_ta_id" TEXT,
    "question_type" "QuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correct_answer" TEXT NOT NULL,
    "grade" DECIMAL(10,2) NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "type" "ExamType" NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" "ExamStatus" NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "approved_by" TEXT,
    "start_time" TIMESTAMPTZ(6) NOT NULL,
    "end_time" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "difficulty_mix" JSONB NOT NULL,
    "target_scope" "TargetScope" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_target_section" (
    "exam_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,

    CONSTRAINT "exam_target_section_pkey" PRIMARY KEY ("exam_id","section_id")
);

-- CreateTable
CREATE TABLE "exam_target_student" (
    "exam_id" UUID NOT NULL,
    "student_id" TEXT NOT NULL,

    CONSTRAINT "exam_target_student_pkey" PRIMARY KEY ("exam_id","student_id")
);

-- CreateTable
CREATE TABLE "student_exam" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" "StudentExamStatus" NOT NULL DEFAULT 'not_started',
    "started_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "total_grade" DECIMAL(10,2),
    "last_heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "student_exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_exam_question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_exam_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "selected_answer" TEXT,
    "is_flagged" BOOLEAN NOT NULL DEFAULT false,
    "grade_awarded" DECIMAL(10,2),
    "credit_adjustment_reason" TEXT,

    CONSTRAINT "student_exam_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_compensation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "adjusted_by" TEXT NOT NULL,
    "adjustment_type" TEXT NOT NULL,
    "adjustment_value" DECIMAL(10,2),
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_compensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_default" (
    "role" "Role" NOT NULL,
    "permission_key" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,

    CONSTRAINT "permission_default_pkey" PRIMARY KEY ("role","permission_key")
);

-- CreateTable
CREATE TABLE "user_permission_override" (
    "user_id" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,

    CONSTRAINT "user_permission_override_pkey" PRIMARY KEY ("user_id","permission_key")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "ImportType" NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'dry_run',
    "total_rows" INTEGER NOT NULL,
    "valid_rows" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excel_import_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_type" "ImportType" NOT NULL,
    "batch_id" UUID,
    "uploaded_by" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "imported_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "error_report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "excel_import_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seb_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seb_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requested_by" TEXT NOT NULL,
    "exam_id" UUID,
    "subject_id" UUID,
    "scope" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'queued',
    "file_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_expiresAt_idx" ON "session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_expiresAt_idx" ON "verification"("identifier", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "department_code_key" ON "department"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subject_code_key" ON "subject"("code");

-- CreateIndex
CREATE UNIQUE INDEX "term_name_key" ON "term"("name");

-- CreateIndex
CREATE INDEX "enrollment_subject_id_term_id_idx" ON "enrollment"("subject_id", "term_id");

-- CreateIndex
CREATE INDEX "section_subject_id_term_id_idx" ON "section"("subject_id", "term_id");

-- CreateIndex
CREATE INDEX "section_ta_id_idx" ON "section"("ta_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_subject_id_term_id_name_key" ON "section"("subject_id", "term_id", "name");

-- CreateIndex
CREATE INDEX "section_membership_section_id_idx" ON "section_membership"("section_id");

-- CreateIndex
CREATE INDEX "question_subject_id_difficulty_idx" ON "question"("subject_id", "difficulty");

-- CreateIndex
CREATE INDEX "question_subject_id_owner_type_idx" ON "question"("subject_id", "owner_type");

-- CreateIndex
CREATE INDEX "exam_subject_id_term_id_start_time_idx" ON "exam"("subject_id", "term_id", "start_time");

-- CreateIndex
CREATE INDEX "exam_status_idx" ON "exam"("status");

-- CreateIndex
CREATE INDEX "student_exam_exam_id_status_idx" ON "student_exam"("exam_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "student_exam_exam_id_student_id_key" ON "student_exam"("exam_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_exam_question_student_exam_id_question_id_key" ON "student_exam_question"("student_exam_id", "question_id");

-- CreateIndex
CREATE INDEX "exam_event_exam_id_created_at_idx" ON "exam_event"("exam_id", "created_at");

-- CreateIndex
CREATE INDEX "exam_compensation_exam_id_idx" ON "exam_compensation"("exam_id");

-- CreateIndex
CREATE INDEX "import_batch_status_expires_at_idx" ON "import_batch"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "excel_import_log_batch_id_key" ON "excel_import_log"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "seb_key_label_key" ON "seb_key"("label");

-- CreateIndex
CREATE UNIQUE INDEX "seb_key_key_hash_key" ON "seb_key"("key_hash");

-- CreateIndex
CREATE INDEX "export_job_status_created_at_idx" ON "export_job"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_created_at_idx" ON "audit_log"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject" ADD CONSTRAINT "subject_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_assignment" ADD CONSTRAINT "doctor_assignment_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_assignment" ADD CONSTRAINT "doctor_assignment_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_assignment" ADD CONSTRAINT "doctor_assignment_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_ta_id_fkey" FOREIGN KEY ("ta_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_membership" ADD CONSTRAINT "section_membership_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_membership" ADD CONSTRAINT "section_membership_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question" ADD CONSTRAINT "question_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question" ADD CONSTRAINT "question_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question" ADD CONSTRAINT "question_added_by_ta_id_fkey" FOREIGN KEY ("added_by_ta_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam" ADD CONSTRAINT "exam_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam" ADD CONSTRAINT "exam_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam" ADD CONSTRAINT "exam_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam" ADD CONSTRAINT "exam_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_target_section" ADD CONSTRAINT "exam_target_section_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_target_section" ADD CONSTRAINT "exam_target_section_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_target_student" ADD CONSTRAINT "exam_target_student_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_target_student" ADD CONSTRAINT "exam_target_student_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_exam" ADD CONSTRAINT "student_exam_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_exam" ADD CONSTRAINT "student_exam_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_exam_question" ADD CONSTRAINT "student_exam_question_student_exam_id_fkey" FOREIGN KEY ("student_exam_id") REFERENCES "student_exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_exam_question" ADD CONSTRAINT "student_exam_question_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_event" ADD CONSTRAINT "exam_event_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_compensation" ADD CONSTRAINT "exam_compensation_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_compensation" ADD CONSTRAINT "exam_compensation_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_compensation" ADD CONSTRAINT "exam_compensation_adjusted_by_fkey" FOREIGN KEY ("adjusted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_override" ADD CONSTRAINT "user_permission_override_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excel_import_log" ADD CONSTRAINT "excel_import_log_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excel_import_log" ADD CONSTRAINT "excel_import_log_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
