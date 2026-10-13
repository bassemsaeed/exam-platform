import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth/api";
import { auth } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { EXAM_BROADCAST_TYPES, mayChangePassword } from "../lib/domain.js";
import { emitExamEvent, subscribeExamEvents, unsubscribeExamEvents, type ExamEventData } from "../lib/events.js";
import { prisma } from "../lib/prisma.js";
import { dbNow } from "../lib/prisma.js";
import { sampleExamQuestions } from "../lib/sampling.js";
import { entryCodeMatches } from "../lib/sebCrypto.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireAuth, requirePermission, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { idempotency } from "../middleware/idempotency.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireSeb } from "../middleware/seb.js";

export const student: RouterType = Router();
student.use(requireAuth);

// GET /api/v1/student/me — identity + current-term context for the frontend.
student.get("/me", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const me = await prisma.user.findUnique({
    where: { id: a.userId },
    select: { id: true, username: true, name: true, email: true, role: true, canChangePassword: true, isActive: true },
  });
  const term = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  res.json({ ...me, term });
});

// GET /api/v1/student/results — my own graded sittings (no SEB: dashboard
// data, no live content, never any correct answers).
student.get("/results", requireRole("student"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const rows = await prisma.studentExam.findMany({
    where: { studentId: a.userId, status: { in: ["submitted", "auto_submitted"] } },
    orderBy: { submittedAt: "desc" },
    select: {
      id: true,
      status: true,
      totalGrade: true,
      submittedAt: true,
      exam: {
        select: {
          id: true,
          type: true,
          startTime: true,
          endTime: true,
          durationMinutes: true,
          subject: { select: { code: true, name: true } },
        },
      },
    },
  });
  res.json(rows);
});

// POST /api/v1/student/change-password — students blocked by canChangePassword=false.
student.post("/change-password", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const me = await prisma.user.findUnique({ where: { id: a.userId }, select: { role: true, canChangePassword: true } });
  if (!me || !mayChangePassword(me.role, me.canChangePassword)) {
    return res.status(403).json({ error: "password managed by admin" });
  }
  const { currentPassword, newPassword } = z
    .object({ currentPassword: z.string(), newPassword: z.string().min(config.password.minLength) })
    .parse(req.body);
  const r = await auth.api.changePassword({ body: { currentPassword, newPassword }, headers: fromNodeHeaders(req.headers) }).catch((error: unknown) => {
    if (error instanceof APIError) {
      res.status(error.statusCode).json({ error: error.body?.code === "INVALID_PASSWORD" ? "The current password is incorrect." : error.body?.message ?? "Unable to change password." });
      return null;
    }
    throw error;
  });
  if (r === null) return;
  // A password change must lock out everywhere else: kill every other live
  // session so a stolen older cookie cannot outlive the rotation.
  const sess = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  const token = (sess?.session as { token?: string } | undefined)?.token;
  if (token) await prisma.session.deleteMany({ where: { userId: a.userId, token: { not: token } } });
  res.json(r);
});

// GET /api/v1/student/exams — enrolled + in-window + section match (current term).
student.get("/exams", requireSeb, async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const term = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!term) return res.json([]);
  const now = new Date();
  const [enrolled, memberOf] = await Promise.all([
    prisma.enrollment.findMany({ where: { studentId: a.userId, termId: term.id }, select: { subjectId: true } }),
    // Term-scoped: last year's Section A must not match this year's exams.
    prisma.sectionMembership.findMany({ where: { studentId: a.userId, section: { termId: term.id } }, select: { sectionId: true } }),
  ]);
  const subjectIds = enrolled.map((e) => e.subjectId);
  const sectionIds = memberOf.map((m) => m.sectionId);
  const exams = await prisma.exam.findMany({
    where: {
      termId: term.id,
      status: "approved",
      subjectId: { in: subjectIds },
      startTime: { lte: now },
      endTime: { gte: now },
      OR: [
        { targetScope: "subject" },
        { targetSections: { some: { sectionId: { in: sectionIds } } } },
        { targetStudents: { some: { studentId: a.userId } } },
      ],
      // Submitted stays locked and disappears (resume lives in start → existing instance).
      instances: { none: { studentId: a.userId, status: { in: ["submitted", "auto_submitted"] } } },
    },
    select: { id: true, subjectId: true, type: true, startTime: true, endTime: true, durationMinutes: true, accessCodeHash: true, subject: { select: { id: true, name: true, code: true } } },
    orderBy: { startTime: "asc" },
  });
  // Presence only: the hash itself must never reach the browser (offline brute force).
  res.json(exams.map(({ accessCodeHash, ...rest }) => ({ ...rest, requiresCode: accessCodeHash !== null })));
});

// GET /student/exams/upcoming — approved, eligible, but the window hasn't
// opened yet. Same gates as the live list (minus the open-window filter) so
// the bell's "Upcoming exam" always has a matching card somewhere.
student.get("/exams/upcoming", requireSeb, async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const term = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!term) return res.json([]);
  const now = new Date();
  const [enrolled, memberOf] = await Promise.all([
    prisma.enrollment.findMany({ where: { studentId: a.userId, termId: term.id }, select: { subjectId: true } }),
    prisma.sectionMembership.findMany({ where: { studentId: a.userId, section: { termId: term.id } }, select: { sectionId: true } }),
  ]);
  const subjectIds = enrolled.map((e) => e.subjectId);
  const sectionIds = memberOf.map((m) => m.sectionId);
  if (!subjectIds.length) return res.json([]);
  const exams = await prisma.exam.findMany({
    where: {
      termId: term.id,
      status: "approved",
      subjectId: { in: subjectIds },
      startTime: { gt: now },
      endTime: { gte: now },
      OR: [
        { targetScope: "subject" },
        { targetSections: { some: { sectionId: { in: sectionIds } } } },
        { targetStudents: { some: { studentId: a.userId } } },
      ],
      instances: { none: { studentId: a.userId, status: { in: ["submitted", "auto_submitted"] } } },
    },
    select: { id: true, subjectId: true, type: true, startTime: true, endTime: true, durationMinutes: true, accessCodeHash: true, subject: { select: { id: true, name: true, code: true } } },
    orderBy: { startTime: "asc" },
  });
  res.json(exams.map(({ accessCodeHash, ...rest }) => ({ ...rest, requiresCode: accessCodeHash !== null })));
});

// Grading with live compensations: correctness first, then the exam's
// compensation rows overlay per question (full_credit / set-capped /
// delta-capped). Mid-exam voids therefore survive submit instead of being
// recomputed away — and a delta never freezes an unanswered NULL row.
// Targeted rows (non-empty studentIds) apply only to their students: late
// submitters get the same scope the live SQL applied to early ones.
interface CompRow {
  questionId: string;
  adjustmentType: string;
  adjustmentValue: unknown;
  studentIds: string[];
}

async function compensationMap(
  tx: { examCompensation: { findMany(args: unknown): Promise<CompRow[]> } },
  examId: string,
) {
  const rows = await tx.examCompensation.findMany({ where: { examId } });
  return new Map(rows.map((c) => [c.questionId, c]));
}

function gradeWithCompensation(
  selectedAnswer: string | null,
  correctAnswer: string,
  grade: unknown,
  studentId: string,
  comp?: CompRow,
): Prisma.Decimal {
  const full = Number(grade);
  let v = selectedAnswer !== null && selectedAnswer === correctAnswer ? full : 0;
  // Wrong scope = no compensation for this student.
  if (comp && (comp.studentIds.length === 0 || comp.studentIds.includes(studentId))) {
    if (comp.adjustmentType === "full_credit") v = full;
    else if (comp.adjustmentType === "set") v = Math.min(Math.max(Number(comp.adjustmentValue ?? 0), 0), full);
    else v = Math.max(0, Math.min(full, v + Number(comp.adjustmentValue ?? 0)));
  }
  return new Prisma.Decimal(v.toFixed(2));
}

// Helper: auto-submit exam on wall-clock expiry. Accepts null answers and scores them 0.
// Runs once per instance (callers check status first); emits the submitted event
// + audit so expiry is as observable as a manual submit.
// Exported for the background sweeper (no import cycle: worker → route only).
export async function autoSubmitExam(studentExamId: string) {
  const computed = await prisma.$transaction(async (tx) => {
    const se = await tx.studentExam.findUnique({
      where: { id: studentExamId },
      include: { questions: { include: { question: true } } },
    });
    if (!se || se.status === "submitted" || se.status === "auto_submitted") return null;

    const comps = await compensationMap(tx as never, se.examId);
    // Compute all awards first (no I/O), then write concurrently: the old
    // sequential per-question loop issued 50 serial UPDATEs per dropout (5k
    // statements per sweeper tick). Promise.all keeps one round-trip set.
    const awards = se.questions.map((q) => ({
      id: q.id,
      awarded: gradeWithCompensation(q.selectedAnswer, q.question.correctAnswer, q.question.grade, se.studentId, comps.get(q.questionId)),
    }));
    let total = new Prisma.Decimal(0);
    for (const aw of awards) total = total.plus(aw.awarded);
    await Promise.all(
      awards.map((aw) =>
        tx.studentExamQuestion.update({
          where: { id: aw.id },
          data: { gradeAwarded: aw.awarded },
        }),
      ),
    );

    // Conditional close: a manual submit racing the sweeper wins once. The
    // loser sees count 0 and returns the winner instead of overwriting a
    // clean manual submit with auto_submitted (B-05).
    const closed = await tx.studentExam.updateMany({
      where: { id: se.id, status: "in_progress" },
      data: {
        status: "auto_submitted",
        submittedAt: await dbNow(),
        totalGrade: total,
      },
    });
    if (closed.count === 0) return null;
    return { studentId: se.studentId, examId: se.examId, id: se.id };
  });
  if (!computed) {
    return prisma.studentExam.findUnique({ where: { id: studentExamId } });
  }
  const updated = await prisma.studentExam.findUniqueOrThrow({ where: { id: studentExamId } });
  try {
    await audit(computed.studentId, "student_exam.auto_submit", "student_exam", updated.id, {
      examId: computed.examId,
    });
  } catch {
    // best-effort: grading already committed, never 500 on audit
  }
  await emitExamEvent(computed.examId, "submitted", {
    studentId: computed.studentId,
    examId: computed.examId,
    auto: true,
  });
  return updated;
}

// Shared eligibility: enrollment + targetScope (sections / student_list).
// Used by start (new instances) and the SSE stream so non-targeted students
// can neither sit nor listen to someone else's exam. Returns a reason or null.
async function examEligibility(
  exam: {
    subjectId: string;
    termId: string;
    targetScope: string;
    targetSections: { sectionId: string }[];
    targetStudents: { studentId: string }[];
  },
  studentId: string,
): Promise<string | null> {
  const enrolled = await prisma.enrollment.count({
    where: { studentId, subjectId: exam.subjectId, termId: exam.termId },
  });
  if (!enrolled) return "not enrolled in subject";

  if (exam.targetScope === "sections") {
    const targetSecIds = exam.targetSections.map((t) => t.sectionId);
    const inSection = await prisma.sectionMembership.count({
      where: {
        studentId,
        sectionId: { in: targetSecIds },
        section: { termId: exam.termId },
      },
    });
    if (!inSection) return "not in targeted section";
  } else if (exam.targetScope === "student_list") {
    if (!exam.targetStudents.some((t) => t.studentId === studentId)) {
      return "not in targeted student list";
    }
  }
  return null;
}

// Read-only preflight using the same identity, permission, SEB and targeting gates as starting.
student.get(
  "/exams/:id/readiness",
  requireRole("student"),
  requirePermission("take_exam"),
  requireSeb,
  async (req, res) => {
    const a = req as unknown as AuthedRequest;
    const exam = await prisma.exam.findUnique({
      where: { id: String(req.params.id) },
      include: {
        targetSections: true,
        targetStudents: true,
        subject: { select: { name: true, code: true } },
      },
    });
    if (!exam) return res.status(404).json({ error: "exam not found" });
    const existing = await prisma.studentExam.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: a.userId } },
      select: { status: true },
    });
    if (!existing) {
      const eligibility = await examEligibility(exam, a.userId);
      if (eligibility) return res.status(403).json({ error: eligibility });
    }
    const now = await dbNow();
    const submitted =
      existing?.status === "submitted" || existing?.status === "auto_submitted";
    const resumable = !!existing && !submitted;
    const available =
      exam.status === "approved" &&
      exam.startTime <= now &&
      exam.endTime >= now;
    res.json({
      subject: exam.subject,
      durationMinutes: exam.durationMinutes,
      startTime: exam.startTime,
      endTime: exam.endTime,
      requiresCode: !!exam.accessCodeHash,
      resumable,
      submitted,
      ready: !submitted && (resumable || available),
      serverTime: now,
      // Server-verified (this handler sits behind requireSeb): the checklist
      // must show THIS, never infer SEB from "data loaded" client-side.
      sebVerified: true,
      attemptStatus: existing?.status ?? null,
      examStatus: exam.status,
    });
  },
);

// POST /api/v1/student/exams/:id/start
// Atomic find-or-create student_exam. Samples questions without ORDER BY random().
// Returns existing instance on resume. Gated by SEB. No idempotency cache:
// double-start is already safe (atomic find-or-create + P2002 race returns the
// winner), while a cached 201 would replay a stale clock within the TTL.
student.post(
  "/exams/:id/start",
  requireRole("student"),
  requirePermission("take_exam"),
  requireSeb,
  rateLimit(config.studentRateLimit.startMax, config.studentRateLimit.startWindowMs, "student:start"),
  async (req, res) => {
    const a = req as unknown as AuthedRequest;
    const examId = String(req.params.id);

    const exam = await prisma.exam.findUnique({
      where: { id: examId },
      include: {
        targetSections: true,
        targetStudents: true,
      },
    });
    if (!exam) return res.status(404).json({ error: "exam not found" });

    // Resume FIRST: a disconnected student reconnecting after exam.endTime must
    // still reach their instance (auto-submit + grade) instead of being bounced
    // by the window gate with the row stranded in_progress. Approval / window /
    // eligibility below gate NEW starts only — disconnect != submit.
    // DB clock: expiry is decided against the same NOW() the sweeper uses, so
    // app/DB skew cannot strand or prematurely kill instances.
    const now = (await dbNow()).getTime();
    const existing = await prisma.studentExam.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: a.userId } },
      include: {
        questions: {
          include: {
            question: {
              select: {
                id: true,
                questionType: true,
                text: true,
                options: true,
                grade: true,
                difficulty: true,
                imageUrl: true,
                // SECURITY: Never include correctAnswer in student queries!
              },
            },
          },
          orderBy: { id: "asc" },
        },
      },
    });

    if (existing) {
      if (existing.status === "submitted" || existing.status === "auto_submitted") {
        return res.status(409).json({ error: "exam already submitted" });
      }

      // Check wall-clock expiry
      const startedAt = existing.startedAt ? existing.startedAt.getTime() : now;
      const maxEndTime = Math.min(exam.endTime.getTime(), startedAt + exam.durationMinutes * 60_000);

      if (now >= maxEndTime) {
        await autoSubmitExam(existing.id);
        return res.status(409).json({ error: "exam duration expired, auto-submitted" });
      }

      // Resume: return existing questions and wall-clock remaining seconds
      const remainingSeconds = Math.max(0, Math.floor((maxEndTime - now) / 1000));
      return res.json({
        id: existing.id,
        examId: existing.examId,
        status: existing.status,
        startedAt: existing.startedAt,
        durationMinutes: exam.durationMinutes,
        remainingSeconds,
        questions: existing.questions.map((q) => ({
          id: q.id,
          questionId: q.questionId,
          questionType: q.question.questionType,
          text: q.question.text,
          options: q.question.options,
          grade: q.question.grade,
          difficulty: q.question.difficulty,
          imageUrl: q.question.imageUrl,
          selectedAnswer: q.selectedAnswer,
          isFlagged: q.isFlagged,
        })),
      });
    }

    // New instance gates: approval, window, eligibility, entry code.
    if (exam.status !== "approved") return res.status(403).json({ error: "exam not approved" });
    if (exam.accessCodeHash) {
      const { accessCode } = z.object({ accessCode: z.string().max(64).optional() }).parse(req.body ?? {});
      if (!accessCode || !entryCodeMatches(accessCode.trim(), exam.accessCodeHash)) {
        return res.status(403).json({ error: "incorrect entry code" });
      }
    }
    if (now < exam.startTime.getTime()) return res.status(409).json({ error: "exam has not started yet" });
    if (now > exam.endTime.getTime()) return res.status(409).json({ error: "exam has ended" });

    const eligible = await examEligibility(exam, a.userId);
    if (eligible) return res.status(403).json({ error: eligible });

    // New instance: sample questions without ORDER BY random()
    const sample = await sampleExamQuestions(prisma, {
      id: exam.id,
      subjectId: exam.subjectId,
      createdBy: exam.createdBy,
      type: exam.type,
      questionSource: exam.questionSource,
      difficultyMix: exam.difficultyMix,
      manualQuestionIds: exam.manualQuestionIds,
    });

    if (!sample.ok) {
      return res.status(422).json({ error: sample.error, need: sample.need, have: sample.have });
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const started = await dbNow();
        const se = await tx.studentExam.create({
          data: {
            examId: exam.id,
            studentId: a.userId,
            status: "in_progress",
            startedAt: started,
            lastHeartbeatAt: started,
            questions: {
              create: sample.questionIds.map((qid) => ({
                questionId: qid,
              })),
            },
          },
          include: {
            questions: {
              include: {
                question: {
                  select: {
                    id: true,
                    questionType: true,
                    text: true,
                    options: true,
                    grade: true,
                    difficulty: true,
                    imageUrl: true,
                  },
                },
              },
              orderBy: { id: "asc" },
            },
          },
        });
        return se;
      });

      try {
        await audit(a.userId, "student_exam.start", "student_exam", created.id, { examId: exam.id });
      } catch {
        // best-effort: instance already committed, never 500 on audit
      }
      await emitExamEvent(exam.id, "started", { studentId: a.userId, examId: exam.id });

      const maxEndTime = Math.min(exam.endTime.getTime(), created.startedAt!.getTime() + exam.durationMinutes * 60_000);
      const remainingSeconds = Math.max(0, Math.floor((maxEndTime - Date.now()) / 1000));

      return res.status(201).json({
        id: created.id,
        examId: created.examId,
        status: created.status,
        startedAt: created.startedAt,
        durationMinutes: exam.durationMinutes,
        remainingSeconds,
        questions: created.questions.map((q) => ({
          id: q.id,
          questionId: q.questionId,
          questionType: q.question.questionType,
          text: q.question.text,
          options: q.question.options,
          grade: q.question.grade,
          difficulty: q.question.difficulty,
          imageUrl: q.question.imageUrl,
          selectedAnswer: q.selectedAnswer,
          isFlagged: q.isFlagged,
        })),
      });
    } catch (e) {
      // Parallel start collision: return the winner's instance
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const raceInstance = await prisma.studentExam.findUniqueOrThrow({
          where: { examId_studentId: { examId: exam.id, studentId: a.userId } },
          include: {
            questions: {
              include: {
                question: {
                  select: {
                    id: true,
                    questionType: true,
                    text: true,
                    options: true,
                    grade: true,
                    difficulty: true,
                    imageUrl: true,
                  },
                },
              },
              orderBy: { id: "asc" },
            },
          },
        });
        const maxEndTime = Math.min(exam.endTime.getTime(), raceInstance.startedAt!.getTime() + exam.durationMinutes * 60_000);
        return res.json({
          id: raceInstance.id,
          examId: raceInstance.examId,
          status: raceInstance.status,
          startedAt: raceInstance.startedAt,
          durationMinutes: exam.durationMinutes,
          remainingSeconds: Math.max(0, Math.floor((maxEndTime - Date.now()) / 1000)),
          questions: raceInstance.questions.map((q) => ({
            id: q.id,
            questionId: q.questionId,
            questionType: q.question.questionType,
            text: q.question.text,
            options: q.question.options,
            grade: q.question.grade,
            difficulty: q.question.difficulty,
            imageUrl: q.question.imageUrl,
            selectedAnswer: q.selectedAnswer,
            isFlagged: q.isFlagged,
          })),
        });
      }
      throw e;
    }
  },
);

// Helper to load an active studentExam instance and check wall-clock expiration.
// Explicit union return so "error" in result narrows (tsc strict).
type RequireActiveOk = {
  se: { id: string; exam: { endTime: Date; durationMinutes: number } };
  maxEndTime: number;
};
type RequireActiveErr = { error: string; status: number };
async function requireActiveExam(examId: string, studentId: string): Promise<RequireActiveOk | RequireActiveErr> {
  const se = await prisma.studentExam.findUnique({
    where: { examId_studentId: { examId, studentId } },
    include: { exam: true },
  });
  if (!se) return { error: "not found" as const, status: 404 };
  if (se.status !== "in_progress") return { error: `exam ${se.status}` as const, status: 409 };

  // DB clock (see start route): matches the sweeper's NOW().
  const now = (await dbNow()).getTime();
  const maxEndTime = Math.min(se.exam.endTime.getTime(), (se.startedAt?.getTime() ?? now) + se.exam.durationMinutes * 60_000);

  if (now >= maxEndTime) {
    await autoSubmitExam(se.id);
    return { error: "exam duration expired, auto-submitted" as const, status: 409 };
  }

  return { se, maxEndTime };
}

// PATCH /api/v1/student/exams/:id/answer (single answer)
student.patch("/exams/:id/answer", requireRole("student"), requirePermission("take_exam"), requireSeb, rateLimit(config.studentRateLimit.answerMax, config.studentRateLimit.answerWindowMs, "student:answers"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const examId = String(req.params.id);
  const body = z
    .object({
      questionId: z.string(),
      selectedAnswer: z.string().nullable(),
    })
    .parse(req.body);

  const active = await requireActiveExam(examId, a.userId);
  if ("error" in active) return res.status(active.status).json({ error: active.error });

  const seq = await prisma.studentExamQuestion.findUnique({
    where: { studentExamId_questionId: { studentExamId: active.se.id, questionId: body.questionId } },
    include: { question: { select: { options: true } } },
  });
  if (!seq) return res.status(404).json({ error: "question not in exam" });

  // Empty string clears the answer (stored as NULL so the submit gate sees it).
  const selected = body.selectedAnswer === "" ? null : body.selectedAnswer;
  if (selected !== null) {
    const validOptions = seq.question.options as string[];
    if (!validOptions.includes(selected)) {
      return res.status(422).json({ error: "selectedAnswer must be one of the question options" });
    }
  }

  const updated = await prisma.studentExamQuestion.update({
    where: { id: seq.id },
    data: { selectedAnswer: selected },
  });

  res.json({ ok: true, questionId: updated.questionId, selectedAnswer: updated.selectedAnswer });
});

// PATCH /api/v1/student/exams/:id/answers (batch answers)
student.patch("/exams/:id/answers", requireRole("student"), requirePermission("take_exam"), requireSeb, rateLimit(config.studentRateLimit.answerMax, config.studentRateLimit.answerWindowMs, "student:answers"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const examId = String(req.params.id);
  const body = z
    .object({
      answers: z.array(
        z.object({
          questionId: z.string(),
          selectedAnswer: z.string().nullable(),
        }),
      ).min(1).max(config.answersBatchMax),
    })
    .parse(req.body);

  const active = await requireActiveExam(examId, a.userId);
  if ("error" in active) return res.status(active.status).json({ error: active.error });

  const questionIds = body.answers.map((ans) => ans.questionId);
  const questions = await prisma.studentExamQuestion.findMany({
    where: { studentExamId: active.se.id, questionId: { in: questionIds } },
    include: { question: { select: { options: true } } },
  });
  const qMap = new Map(questions.map((q) => [q.questionId, q]));

  for (const ans of body.answers) {
    const q = qMap.get(ans.questionId);
    if (!q) return res.status(404).json({ error: `question not in exam: ${ans.questionId}` });
    const selected = ans.selectedAnswer === "" ? null : ans.selectedAnswer;
    if (selected !== null) {
      const validOptions = q.question.options as string[];
      if (!validOptions.includes(selected)) {
        return res.status(422).json({ error: `invalid answer for question ${ans.questionId}` });
      }
    }
  }

  await prisma.$transaction(
    body.answers.map((ans) => {
      const q = qMap.get(ans.questionId)!;
      return prisma.studentExamQuestion.update({
        where: { id: q.id },
        data: { selectedAnswer: ans.selectedAnswer === "" ? null : ans.selectedAnswer },
      });
    }),
  );

  res.json({ ok: true, updated: body.answers.length });
});

// PATCH /api/v1/student/exams/:id/flag
student.patch("/exams/:id/flag", requireRole("student"), requirePermission("take_exam"), requireSeb, rateLimit(config.studentRateLimit.flagMax, config.studentRateLimit.flagWindowMs, "student:flag"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const examId = String(req.params.id);
  const body = z
    .object({
      questionId: z.string(),
      isFlagged: z.boolean(),
    })
    .parse(req.body);

  const active = await requireActiveExam(examId, a.userId);
  if ("error" in active) return res.status(active.status).json({ error: active.error });

  const seq = await prisma.studentExamQuestion.findUnique({
    where: { studentExamId_questionId: { studentExamId: active.se.id, questionId: body.questionId } },
  });
  if (!seq) return res.status(404).json({ error: "question not in exam" });

  const updated = await prisma.studentExamQuestion.update({
    where: { id: seq.id },
    data: { isFlagged: body.isFlagged },
  });

  res.json({ ok: true, questionId: updated.questionId, isFlagged: updated.isFlagged });
});

// POST /api/v1/student/exams/:id/heartbeat
// Updates last_heartbeat_at only — NEVER extends or pauses the wall-clock timer!
student.post("/exams/:id/heartbeat", requireRole("student"), requirePermission("take_exam"), requireSeb, rateLimit(config.studentRateLimit.heartbeatMax, config.studentRateLimit.heartbeatWindowMs, "student:heartbeat"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const examId = String(req.params.id);

  const active = await requireActiveExam(examId, a.userId);
  if ("error" in active) return res.status(active.status).json({ error: active.error });

  await prisma.studentExam.update({
    where: { id: active.se.id },
    data: { lastHeartbeatAt: await dbNow() },
  });

  const remainingSeconds = Math.max(0, Math.floor((active.maxEndTime - Date.now()) / 1000));
  res.json({ ok: true, remainingSeconds });
});

// POST /api/v1/student/exams/:id/submit
// Gated on all questions being answered (409 if any selectedAnswer is null).
// Computes total_grade and stores gradeAwarded per question. Gated by Idempotency-Key.
student.post(
  "/exams/:id/submit",
  requireRole("student"),
  requirePermission("take_exam"),
  requireSeb,
  idempotency,
  rateLimit(config.studentRateLimit.submitMax, config.studentRateLimit.submitWindowMs, "student:submit"),
  async (req, res) => {
    const a = req as unknown as AuthedRequest;
    const examId = String(req.params.id);

    const se = await prisma.studentExam.findUnique({
      where: { examId_studentId: { examId, studentId: a.userId } },
      include: {
        exam: true,
        questions: {
          include: {
            question: true,
          },
        },
      },
    });

    if (!se) return res.status(404).json({ error: "exam instance not found" });

    // Idempotent return if already submitted
    if (se.status === "submitted" || se.status === "auto_submitted") {
      return res.json({
        ok: true,
        status: se.status,
        totalGrade: se.totalGrade,
        submittedAt: se.submittedAt,
      });
    }

    const now = (await dbNow()).getTime();
    const maxEndTime = Math.min(se.exam.endTime.getTime(), (se.startedAt?.getTime() ?? now) + se.exam.durationMinutes * 60_000);

    // Wall-clock expiration auto-submits regardless of blanks
    if (now >= maxEndTime) {
      const updated = await autoSubmitExam(se.id);
      return res.json({
        ok: true,
        status: updated?.status ?? "auto_submitted",
        totalGrade: updated?.totalGrade ?? 0,
        submittedAt: updated?.submittedAt,
      });
    }

    // Manual submission gate: ALL questions must be answered!
    const unanswered = se.questions.filter((q) => q.selectedAnswer === null || q.selectedAnswer === "");
    if (unanswered.length > 0) {
      return res.status(409).json({ error: "unanswered questions remain", unanswered: unanswered.length });
    }

    // Compute grades and finalize in a transaction (compensations overlay correctness).
    // Conditional update: a parallel submit racing us wins once; the loser sees
    // count 0 and returns the winner's row instead of double-emitting.
    // Fresh read INSIDE the tx: answers written concurrently between the
    // outer load and the grade write must not be graded from a stale copy
    // (wrong grades) nor trip the gate on stale blanks (false 409s).
    const finalized = await prisma.$transaction(async (tx) => {
      const fresh = await tx.studentExam.findUnique({
        where: { id: se.id },
        include: { questions: { include: { question: true } } },
      });
      if (!fresh || fresh.status !== "in_progress") return { outcome: "race" as const };
      const stillUnanswered = fresh.questions.filter((q) => q.selectedAnswer === null || q.selectedAnswer === "");
      if (stillUnanswered.length > 0) return { outcome: "unanswered" as const, count: stillUnanswered.length };
      const comps = await compensationMap(tx as never, se.examId);
      const awards = fresh.questions.map((q) => ({
        id: q.id,
        awarded: gradeWithCompensation(q.selectedAnswer, q.question.correctAnswer, q.question.grade, fresh.studentId, comps.get(q.questionId)),
      }));
      let total = new Prisma.Decimal(0);
      for (const aw of awards) total = total.plus(aw.awarded);
      await Promise.all(
        awards.map((aw) => tx.studentExamQuestion.update({ where: { id: aw.id }, data: { gradeAwarded: aw.awarded } })),
      );

      const closed = await tx.studentExam.updateMany({
        where: { id: se.id, status: "in_progress" },
        data: {
          status: "submitted",
          submittedAt: await dbNow(),
          totalGrade: total,
        },
      });
      if (closed.count === 0) return { outcome: "race" as const };
      return { outcome: "done" as const };
    });

    if (finalized.outcome === "unanswered") {
      return res.status(409).json({ error: "unanswered questions remain", unanswered: finalized.count });
    }
    if (finalized.outcome === "race") {
      // Lost the race (or already submitted): return the canonical row.
      const current = await prisma.studentExam.findUniqueOrThrow({ where: { id: se.id } });
      return res.json({ ok: true, status: current.status, totalGrade: current.totalGrade, submittedAt: current.submittedAt });
    }
    const row = await prisma.studentExam.findUniqueOrThrow({ where: { id: se.id } });

    try {
      await audit(a.userId, "student_exam.submit", "student_exam", se.id, { totalGrade: row.totalGrade });
    } catch {
      // best-effort: grades already committed, never 500 on audit
    }
    await emitExamEvent(se.examId, "submitted", { studentId: a.userId, examId: se.examId });

    res.json({
      ok: true,
      status: row.status,
      totalGrade: row.totalGrade,
      submittedAt: row.submittedAt,
    });
  },
);

// GET /api/v1/student/exams/:id/events — Server-Sent Events stream
// Replays missed events from Last-Event-ID and fans out live broadcasts.
// NOTE: browsers' EventSource cannot send the SEB header, so the frontend must
// use fetch + ReadableStream with explicit headers (which also lets it send
// Last-Event-ID on reconnect). ?lastEventId= is accepted as a fallback.
student.get("/exams/:id/events", requireRole("student"), requirePermission("take_exam"), requireSeb, rateLimit(30, 60_000, "student:sse"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const examId = String(req.params.id);

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { targetSections: true, targetStudents: true },
  });
  if (!exam) return res.status(404).json({ error: "exam not found" });

  // Same targeting as start: subject outsiders and non-targeted sections /
  // students cannot eavesdrop on the live stream.
  const eligible = await examEligibility(exam, a.userId);
  if (eligible) return res.status(403).json({ error: eligible });

  // Monotonic seq cursor: UUIDs carry no creation order, so the old
  // (createdAt, id) tiebreak could skip/duplicate same-millisecond broadcasts
  // on reconnect. Garbage cursors replay from the start (bounded below).
  const rawCursor = req.header("Last-Event-ID") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
  const parsedSeq = rawCursor !== undefined ? z.coerce.number().int().nonnegative().safeParse(rawCursor) : null;
  const afterSeq = parsedSeq?.success ? parsedSeq.data : undefined;

  const pastEvents = await prisma.examEvent
    .findMany({
      where: { examId, ...(afterSeq !== undefined ? { seq: { gt: afterSeq } } : {}) },
      orderBy: { seq: "desc" },
      take: config.sseReplayMax,
    })
    .then((rows) => rows.reverse().filter((ev) => (EXAM_BROADCAST_TYPES as readonly string[]).includes(ev.type)));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const ev of pastEvents) {
    res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
  }

  // Live in-process subscription: students get operational broadcasts only.
  // started/submitted carry peer studentIds (telemetry for staff dashboards,
  // retained in DB) and must not fan out to every connected exam taker.
  const onEvent = (ev: ExamEventData) => {
    if (!(EXAM_BROADCAST_TYPES as readonly string[]).includes(ev.type)) return;
    res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
  };
  subscribeExamEvents(examId, onEvent);

  // Periodic SSE comment to keep TCP connection alive through proxies
  const pingInterval = setInterval(() => {
    res.write(": ping\n\n");
  }, config.sseKeepAliveMs);

  req.on("close", () => {
    clearInterval(pingInterval);
    unsubscribeExamEvents(examId, onEvent);
  });
});
