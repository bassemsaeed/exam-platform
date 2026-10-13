-- Indexes for 5k exam-day read paths (results dashboard + question-delete guard)
CREATE INDEX IF NOT EXISTS "student_exam_studentId_status_idx" ON "student_exam"("student_id", "status");
CREATE INDEX IF NOT EXISTS "student_exam_studentId_submittedAt_idx" ON "student_exam"("student_id", "submitted_at");
CREATE INDEX IF NOT EXISTS "student_exam_question_questionId_idx" ON "student_exam_question"("question_id");
CREATE INDEX IF NOT EXISTS "student_exam_question_studentExamId_idx" ON "student_exam_question"("student_exam_id");
