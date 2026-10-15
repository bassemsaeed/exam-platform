import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { EXAM_BROADCAST_TYPES, isExamEventType } from "../lib/domain.js";
import { checkMix, checkWindow, mixShortfall, poolCounts } from "../lib/examRules.js";
import { poolForExam } from "../lib/sampling.js";
import { broadcastExamEvent, emitExamEvent } from "../lib/events.js";
import { hashEntryCode } from "../lib/sebCrypto.js";
import { poolWhere } from "./exams.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminExams: RouterType = Router();
adminExams.use(requireAuth, requireRole("admin"));

// GET /api/v1/admin/exams?status&subject_id&term_id
adminExams.get("/", async (req, res) => {
  const q = pageQuery.extend({ status: z.string().optional(), subject_id: z.string().optional(), term_id: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.status ? { status: q.status as never } : {}),
    ...(q.subject_id ? { subjectId: q.subject_id } : {}),
    ...(q.term_id ? { termId: q.term_id } : {}),
  };
  const [total, found] = await Promise.all([
    prisma.exam.count({ where }),
    prisma.exam.findMany({
      where,
      select: {
        id: true,
        subjectId: true,
        termId: true,
        type: true,
        status: true,
        startTime: true,
        endTime: true,
        durationMinutes: true,
        difficultyMix: true,
        notesEnabled: true,
        notesForDoctorEnabled: true,
        examToolsEnabled: true,
        maxReentries: true,
        targetScope: true,
        createdBy: true,
        rejectionReason: true,
        accessCodeHash: true,
        subject: { select: { code: true, name: true } },
        term: { select: { name: true } },
        creator: { select: { name: true, username: true, role: true } },
      },
      orderBy: { startTime: "desc" },
      ...page(q),
    }),
  ]);
  // Never leak the hash: clients only learn whether a code is set.
  const rows = found.map(({ accessCodeHash, ...rest }) => ({ ...rest, hasAccessCode: accessCodeHash !== null }));
  res.json(envelope(total, q, rows));
});

adminExams.get("/:id", async (req, res) => {
  const row = await prisma.exam.findUnique({
    where: { id: req.params.id },
    include: {
      subject: { select: { id: true, code: true, name: true } },
      term: { select: { id: true, name: true } },
      creator: { select: { id: true, username: true, name: true, role: true } },
      approver: { select: { id: true, username: true, name: true } },
      targetSections: { include: { section: { select: { id: true, name: true } } } },
      targetStudents: { select: { studentId: true } },
      _count: { select: { instances: true } },
    },
  });
  if (!row) return res.status(404).json({ error: "not found" });

  const manualIds = Array.isArray(row.manualQuestionIds) ? (row.manualQuestionIds as string[]) : [];
  let previewQuestions: Array<{ id: string; text: string; type: string; questionType: string; difficulty: string; options: unknown }> = [];
  let previewMode: "manual" | "sample" = "sample";
  if (manualIds.length) {
    // Hand-picked blueprint: show the author's exact questions in author order
    // (not a random pool sample) so approval reviews the real exam.
    const found = await prisma.question.findMany({
      where: { id: { in: manualIds } },
      select: { id: true, text: true, questionType: true, difficulty: true, options: true },
    });
    const byId = new Map(found.map((q) => [q.id, q]));
    previewQuestions = manualIds
      .map((id) => byId.get(id))
      .filter((q) => q !== undefined)
      .map((q) => ({ id: q.id, text: q.text, type: q.questionType, questionType: q.questionType, difficulty: q.difficulty, options: q.options }));
    previewMode = "manual";
  } else {
    const pool = await poolForExam(prisma, row);
    if (pool.ok) {
      const found = await prisma.question.findMany({
        where: pool.where,
        select: { id: true, text: true, questionType: true, difficulty: true, options: true },
        take: 50,
        orderBy: { createdAt: "desc" },
      });
      previewQuestions = found.map((q) => ({ id: q.id, text: q.text, type: q.questionType, questionType: q.questionType, difficulty: q.difficulty, options: q.options }));
    }
  }

  const { accessCodeHash: _dropped, ...safe } = row;
  res.json({ ...safe, hasAccessCode: row.accessCodeHash !== null, previewQuestions, previewMode });
});

// POST /:id/access-code {code} — set (or replace) the hall entry code.
// Given to students ~1 min before the exam; the hash alone is stored, so a
// leaked DB dump cannot open doors. Audited; not rate-limited (admin-only).
// Minimum 6 chars: short unsalted-sha256 codes are trivially brute-forced.
adminExams.post("/:id/access-code", async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(64) }).parse(req.body);
  const me = (req as unknown as AuthedRequest).userId;
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
  if (!exam) return res.status(404).json({ error: "not found" });
  await prisma.exam.update({ where: { id: exam.id }, data: { accessCodeHash: hashEntryCode(code.trim()) } });
  await audit(me, "exam.access-code-set", "exam", exam.id, { status: exam.status });
  res.json({ ok: true, hasAccessCode: true });
});

// DELETE /:id/access-code — reopen free entry (e.g. drill exams).
adminExams.delete("/:id/access-code", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!exam) return res.status(404).json({ error: "not found" });
  await prisma.exam.update({ where: { id: exam.id }, data: { accessCodeHash: null } });
  await audit(me, "exam.access-code-clear", "exam", exam.id);
  res.json({ ok: true, hasAccessCode: false });
});

async function guardEditable(id: string) {
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam) return { error: "not found" as const };
  if (exam.startTime.getTime() <= Date.now())
    return { error: "locked" as const, reason: "exam window has started" };
  return { exam };
}

adminExams.post("/:id/approve", async (req, res) => {
  // Approval stays possible while the window is still open: a pending exam
  // whose start just passed would otherwise be unrescuable (locked forever,
  // never takable). Only a fully-ended exam refuses approval. Edits and
  // deletes keep the strict pre-start lock via guardEditable.
  const exam = await prisma.exam.findUnique({ where: { id: String(req.params.id) } });
  if (!exam) return res.status(404).json({ error: "not found" });
  if (exam.endTime.getTime() <= Date.now())
    return res.status(409).json({ error: "locked", reason: "exam window has ended" });
  const g = { exam };
  // Revalidate the pool at approval time: banks change after creation, and an
  // approved-but-unstartable exam fails on exam day instead of in the queue.
  const manual = Array.isArray(g.exam.manualQuestionIds) ? (g.exam.manualQuestionIds as string[]) : [];
  if (manual.length) {
    const have = await prisma.question.count({ where: { id: { in: manual } } });
    if (have !== manual.length) return res.status(422).json({ error: "blueprint changed: pinned questions no longer exist" });
  } else {
    const pool = await poolForExam(prisma, g.exam);
    if (!pool.ok) return res.status(422).json({ error: pool.error });
    const short = mixShortfall((g.exam.difficultyMix ?? {}) as never, await poolCounts(prisma, pool.where));
    if (short) return res.status(422).json({ error: "bank short for mix", ...short });
  }
  const me = (req as unknown as AuthedRequest).userId;
  const row = await prisma.exam.update({ where: { id: g.exam.id }, data: { status: "approved", approvedBy: me, rejectionReason: null } });
  await audit(me, "exam.approve", "exam", row.id);
  res.json(row);
});

adminExams.post("/:id/reject", async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
  const g = await guardEditable(req.params.id);
  if ("error" in g)
    return res
      .status(g.error === "not found" ? 404 : 409)
      .json("reason" in g ? { error: g.error, reason: g.reason } : { error: g.error });
  const me = (req as unknown as AuthedRequest).userId;
  const row = await prisma.exam.update({ where: { id: g.exam.id }, data: { status: "rejected", rejectionReason: reason, approvedBy: me } });
  await audit(me, "exam.reject", "exam", row.id, { reason });
  res.json(row);
});

// Any edit to an approved exam resets it to pending_approval.
// Hand-picked blueprints lock their mix: patching difficultyMix on a manual
// exam is 422 (prevents the ghost-mix bug where the mix writes but sampling
// keeps serving manualQuestionIds). Convert via delete+recreate instead.
adminExams.patch("/:id", async (req, res) => {
  const body = z
    .object({ notesEnabled: z.boolean().optional(), notesForDoctorEnabled: z.boolean().optional(), examToolsEnabled: z.boolean().optional(), maxReentries: z.number().int().min(0).max(20).optional(), startTime: z.string().datetime().optional(), endTime: z.string().datetime().optional(), durationMinutes: z.number().int().positive().optional(), difficultyMix: z.record(z.string(), z.number()).optional() })
    .parse(req.body);
  const g = await guardEditable(req.params.id);
  if ("error" in g)
    return res
      .status(g.error === "not found" ? 404 : 409)
      .json("reason" in g ? { error: g.error, reason: g.reason } : { error: g.error });
  const manual = Array.isArray(g.exam.manualQuestionIds) ? (g.exam.manualQuestionIds as string[]) : [];
  if (manual.length && body.difficultyMix) {
    return res.status(422).json({ error: "hand-picked blueprint locks difficultyMix: recreate the exam to switch modes" });
  }
  const start = body.startTime ? new Date(body.startTime) : g.exam.startTime;
  const end = body.endTime ? new Date(body.endTime) : g.exam.endTime;
  const duration = body.durationMinutes ?? g.exam.durationMinutes;
  const windowErr = checkWindow(start, end, duration);
  if (windowErr) return res.status(422).json({ error: windowErr });
  if (body.difficultyMix && !checkMix(body.difficultyMix)) {
    return res.status(422).json({ error: "difficultyMix must be {easy?,medium?,hard?} non-negative ints" });
  }
  // All-zero mixes are unstartable: same non-empty rule as create.
  if (body.difficultyMix && Object.values(body.difficultyMix).every((n) => n <= 0)) {
    return res.status(422).json({ error: "blueprint needs at least one question" });
  }
  if (body.difficultyMix) {
    // No bypass via patch-then-grow here either (same rule as staff create).
    // Creator's real role (admin exams sample the whole subject pool).
    const apool = await poolForExam(prisma, g.exam);
    if (apool.ok) {
      const ashort = mixShortfall(body.difficultyMix, await poolCounts(prisma, apool.where));
      if (ashort) return res.status(422).json({ error: "bank short for mix", ...ashort });
    }
  }
  const row = await prisma.exam.update({
    where: { id: g.exam.id },
    data: {
      ...body,
      ...(g.exam.status === "approved" ? { status: "pending_approval" as const, approvedBy: null } : {}),
    },
  });
  await audit((req as unknown as AuthedRequest).userId, "exam.update", "exam", row.id, body);
  res.json(row);
});

adminExams.delete("/:id", async (req, res) => {
  // Admins can delete ANY exam, including live/running ones: a broken exam
  // stuck in production must be removable without waiting for its window.
  // Children (sittings, questions rows, events, compensations, targets)
  // cascade at the DB level; export jobs are kept with examId nulled.
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) return res.status(404).json({ error: "not found" });
  const me = (req as unknown as AuthedRequest).userId;
  const started = exam.startTime.getTime() <= Date.now();
  const sittings = await prisma.studentExam.count({ where: { examId: exam.id } });
  if (started || sittings > 0) {
    // Best-effort kick: connected students learn the exam is gone instead of
    // polling a 404. The row is cascade-deleted right after, so broadcast first.
    try {
      broadcastExamEvent(await emitExamEvent(exam.id, "closed", { reason: "deleted by admin" }));
    } catch {
      // Broadcast must never block the delete itself.
    }
  }
  await prisma.exam.delete({ where: { id: exam.id } });
  await audit(me, "exam.delete", "exam", exam.id, { status: exam.status, started, sittings });
  res.json({ ok: true });
});

// POST /:id/compensate {question_id, adjustment_type, adjustment_value?, student_ids?|all, reason*}
adminExams.post("/:id/compensate", async (req, res) => {
  const body = z
    .object({
      question_id: z.string(),
      adjustment_type: z.enum(["full_credit", "delta", "set"]),
      adjustment_value: z.number().optional(),
      student_ids: z.array(z.string()).max(config.lists.compensateMax).optional(),
      reason: z.string().min(3),
    })
    .parse(req.body);
  const me = (req as unknown as AuthedRequest).userId;
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!exam) return res.status(404).json({ error: "not found" });
  const question = await prisma.question.findUnique({ where: { id: body.question_id }, select: { id: true, grade: true } });
  if (!question) return res.status(404).json({ error: "question not found" });
  // The question must belong to THIS exam (pinned blueprint or sampled
  // sitting): a typo'd or foreign ID would otherwise write the wrong tier
  // and leave a misleading compensation trail.
  const inExam =
    (await prisma.studentExamQuestion.count({ where: { questionId: question.id, studentExam: { examId: exam.id } } })) > 0 ||
    (await prisma.exam.count({ where: { id: exam.id, manualQuestionIds: { array_contains: question.id } } })) > 0;
  if (!inExam) return res.status(422).json({ error: "question is not part of this exam" });
  const fullGrade = Number(question.grade);
  if (body.adjustment_type === "set") {
    if (body.adjustment_value == null || body.adjustment_value < 0 || body.adjustment_value > fullGrade) {
      return res.status(422).json({ error: "set value must be within 0 and the question grade" });
    }
  }
  // One row per (exam, question) — enforced by unique index. Duplicates grade
  // inconsistently by submit timing (live SQL is incremental, submit-time
  // overlay is last-wins), so the second compensate is a 409, not a silent fork.
  const dupe = await prisma.examCompensation.findUnique({
    where: { examId_questionId: { examId: exam.id, questionId: question.id } },
    select: { id: true },
  });
  if (dupe) return res.status(409).json({ error: "compensation already exists for this question", compensationId: dupe.id });

  // Set-based + atomic: one transaction, three statements total regardless of
  // student count (was 3N sequential queries with partial-failure risk).
  // Only already-submitted instances are rewritten here: in-progress students
  // get the overlay applied at submit time (submit recomputes correctness,
  // then applies exam_compensation rows), so mid-exam voids can never freeze
  // a NULL row into a raw delta. Grades are floored at 0 in both paths so a
  // negative delta/set can never push the gradebook below zero.
  const delta = body.adjustment_value ?? 0;
  // Targeted voids persist their target list on the row so late submitters
  // get the SAME scope via the submit-time overlay (previously the live SQL
  // filtered but the overlay applied to everyone).
  const targets = [...new Set(body.student_ids ?? [])];
  const studentFilter =
    targets.length > 0
      ? Prisma.sql`AND se.student_id IN (${Prisma.join(targets)})`
      : Prisma.empty;

  let compensationId: string;
  let affected: number;
  let ev: { id: string; examId: string; seq: number; type: string; payload: unknown; createdAt: Date };
  try {
    const out = await prisma.$transaction(async (tx) => {
      const comp = await tx.examCompensation.create({
        data: {
          examId: exam.id,
          questionId: question.id,
          adjustedBy: me,
          adjustmentType: body.adjustment_type,
          adjustmentValue: body.adjustment_value ?? null,
          studentIds: targets,
          reason: body.reason,
        },
      });
      const graded = await tx.$executeRaw`
      UPDATE student_exam_question seq SET
        grade_awarded = CASE
          WHEN ${body.adjustment_type} = 'full_credit' THEN ${fullGrade}
          WHEN ${body.adjustment_type} = 'set' THEN LEAST(${fullGrade}, GREATEST(0, ${delta}))
          ELSE GREATEST(0, LEAST(${fullGrade}, COALESCE(seq.grade_awarded, 0) + ${delta}))
        END,
        credit_adjustment_reason = ${body.reason}
      FROM student_exam se
      WHERE seq.student_exam_id = se.id
        AND se.exam_id = ${exam.id}::uuid
        AND seq.question_id = ${question.id}::uuid
        AND se.status IN ('submitted', 'auto_submitted')
        ${studentFilter}`;
      await tx.$executeRaw`
      UPDATE student_exam se SET total_grade = sub.total FROM (
        SELECT student_exam_id, SUM(COALESCE(grade_awarded, 0)) AS total
        FROM student_exam_question GROUP BY student_exam_id
      ) sub
      WHERE se.id = sub.student_exam_id AND se.exam_id = ${exam.id}::uuid
        AND se.status IN ('submitted', 'auto_submitted')
        ${studentFilter}`;
      const evRow = await tx.examEvent.create({
        data: { examId: exam.id, type: "voided", payload: { compensationId: comp.id, questionId: question.id, affected: Number(graded) } },
      });
      return { compensationId: comp.id, affected: Number(graded), ev: evRow };
    });
    ({ compensationId, affected, ev } = out);
  } catch (e) {
    // Lost the unique race with another admin: report 409 like the pre-check.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "compensation already exists for this question" });
    }
    throw e;
  }
  broadcastExamEvent({
    id: ev.id,
    examId: ev.examId,
    seq: ev.seq,
    type: ev.type,
    payload: ev.payload,
    createdAt: ev.createdAt,
  });
  await audit(me, "exam.compensate", "exam", exam.id, { ...body, affected });
  res.json({ ok: true, affected, compensationId });
});

adminExams.get("/:id/compensations", async (req, res) => {
  res.json(await prisma.examCompensation.findMany({ where: { examId: String(req.params.id) }, orderBy: { createdAt: "desc" } }));
});

// GET /api/v1/admin/exams/:id/live — who is sitting THIS exam right now.
// Proctoring roster: every in_progress instance with student identity,
// term sections, wall-clock remaining, last heartbeat (+stale flag) and
// answered/total progress. Read-only (no audit noise on poll).
adminExams.get("/:id/live", async (req, res) => {
  const exam = await prisma.exam.findUnique({
    where: { id: req.params.id },
    select: { id: true, termId: true, durationMinutes: true, endTime: true },
  });
  if (!exam) return res.status(404).json({ error: "not found" });
  const now = Date.now();
  const staleCutoff = new Date(now - config.heartbeat.staleMs);
  const instances = await prisma.studentExam.findMany({
    where: { examId: exam.id, status: "in_progress" },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      startedAt: true,
      lastHeartbeatAt: true,
      student: { select: { id: true, name: true, username: true } },
      _count: { select: { questions: true } },
    },
  });
  const ids = instances.map((s) => s.id);
  const studentIds = [...new Set(instances.map((s) => s.student.id))];
  const [answeredGroups, memberships] = await Promise.all([
    ids.length
      ? prisma.studentExamQuestion.groupBy({
          by: ["studentExamId"],
          where: { studentExamId: { in: ids }, NOT: [{ selectedAnswer: null }, { selectedAnswer: "" }] },
          _count: { _all: true },
        })
      : [],
    studentIds.length
      ? prisma.sectionMembership.findMany({
          where: { studentId: { in: studentIds }, section: { termId: exam.termId } },
          select: { studentId: true, section: { select: { name: true } } },
        })
      : [],
  ]);
  const answeredBy = new Map(answeredGroups.map((g) => [g.studentExamId, g._count._all]));
  const sectionsBy = new Map<string, string[]>();
  for (const m of memberships) {
    const list = sectionsBy.get(m.studentId) ?? [];
    list.push(m.section.name);
    sectionsBy.set(m.studentId, list);
  }
  const rows = instances.map((s) => {
    const maxEnd = Math.min(exam.endTime.getTime(), (s.startedAt?.getTime() ?? now) + exam.durationMinutes * 60_000);
    return {
      id: s.id,
      student: s.student,
      sections: sectionsBy.get(s.student.id) ?? [],
      startedAt: s.startedAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      stale: !s.lastHeartbeatAt || s.lastHeartbeatAt < staleCutoff,
      answered: answeredBy.get(s.id) ?? 0,
      totalQuestions: s._count.questions,
      remainingSeconds: Math.max(0, Math.floor((maxEnd - now) / 1000)),
    };
  });
  res.json({ examId: exam.id, total: rows.length, staleCutoff, rows });
});

// POST /api/v1/admin/exams/:id/events — broadcast announcement/warning/close to connected students over SSE
adminExams.post("/:id/events", async (req, res) => {
  const body = z
    .object({
      type: z.enum(EXAM_BROADCAST_TYPES),
      payload: z.record(z.string(), z.unknown()),
    })
    .parse(req.body);
  if (!isExamEventType(body.type)) return res.status(422).json({ error: "unknown event type" });
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) return res.status(404).json({ error: "not found" });
  const ev = await emitExamEvent(exam.id, body.type, body.payload);
  await audit((req as unknown as AuthedRequest).userId, "exam.event", "exam", exam.id, body);
  res.status(201).json(ev);
});

