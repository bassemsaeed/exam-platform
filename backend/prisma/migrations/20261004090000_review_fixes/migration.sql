-- Review fixes: targeted compensations, single current term, sound SSE replay
-- cursors, grade-evidence protection, hot-path indexes.

-- H2: per-compensation student targeting (empty array = all students).
ALTER TABLE "exam_compensation" ADD COLUMN "student_ids" TEXT[] NOT NULL DEFAULT '{}';

-- H3: one compensation row per (exam, question); replaces the exam-only index.
DROP INDEX IF EXISTS "exam_compensation_exam_id_idx";
CREATE UNIQUE INDEX "exam_compensation_exam_id_question_id_key" ON "exam_compensation"("exam_id", "question_id");

-- H11: exactly one current term (partial unique index).
CREATE UNIQUE INDEX "term_single_current" ON "term"("is_current") WHERE "is_current";

-- M7: monotonic order for SSE replay cursors (UUIDs have no creation order).
ALTER TABLE "exam_event" ADD COLUMN "seq" SERIAL NOT NULL;
CREATE INDEX "exam_event_exam_id_seq_idx" ON "exam_event"("exam_id", "seq");
DROP INDEX IF EXISTS "exam_event_exam_id_created_at_idx";

-- M12: deleting a user with graded sittings is refused (disable instead).
ALTER TABLE "student_exam" DROP CONSTRAINT "student_exam_student_id_fkey";
ALTER TABLE "student_exam" ADD CONSTRAINT "student_exam_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- L6: hot-path indexes (doctor-assignment subject/term filters, term+status exam queries).
CREATE INDEX IF NOT EXISTS "doctor_assignment_subject_id_term_id_idx" ON "doctor_assignment"("subject_id", "term_id");
CREATE INDEX IF NOT EXISTS "exam_term_id_status_idx" ON "exam"("term_id", "status");
