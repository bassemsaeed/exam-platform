import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { checkMix, checkWindow, mixShortfall, poolCounts } from "../lib/examRules.js";
import { Prisma } from "../generated/prisma/client.js";
import { poolForExam } from "../lib/sampling.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { hasPermission, requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const exams: RouterType = Router();
exams.use(requireAuth);

const mixInput = z.record(z.string(), z.number().int().min(0));

async function currentTermId(): Promise<string | null> {
  const t = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
  return t?.id ?? null;
}

// Pool a new exam samples from: doctor → own private bank; TA → shared or own-only.
export async function poolWhere(
  creatorId: string,
  role: string,
  subjectId: string,
  source: "own" | "shared" | "mine",
): Promise<{ ok: true; where: object } | { ok: false; error: string }> {
  if (role === "doctor") {
    if (source !== "own") return { ok: false, error: "doctor exams sample own bank only" };
    return { ok: true, where: { subjectId, ownerType: "doctor", doctorId: creatorId } };
  }
  if (role === "ta") {
    if (source !== "shared" && source !== "mine") return { ok: false, error: "choose shared|mine" };
    return { ok: true, where: { subjectId, ownerType: "ta_shared", ...(source === "mine" ? { addedByTaId: creatorId } : {}) } };
  }
  return { ok: true, where: { subjectId } }; // admin preview path
}

// GET /exams/subjects — subjects the caller may work in (current term).
// Doctor: assigned subjects. TA: subjects of own sections. Students: 403.
exams.get("/subjects", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const termId = await currentTermId();
  if (!termId) return res.json(envelope(0, { page: 1, limit: 1 }, []));
  if (a.role === "doctor") {
    const rows = await prisma.doctorAssignment.findMany({
      where: { doctorId: a.userId, termId },
      select: { subject: { select: { id: true, code: true, name: true } } },
    });
    const subjects = rows.map((r) => r.subject);
    return res.json(envelope(subjects.length, { page: 1, limit: Math.max(subjects.length, 1) }, subjects));
  }
  if (a.role === "ta") {
    const secs = await prisma.section.findMany({
      where: { taId: a.userId, termId },
      select: { subject: { select: { id: true, code: true, name: true } } },
    });
    const seen = new Map(secs.map((s) => [s.subject.id, s.subject]));
    const subjects = [...seen.values()];
    return res.json(envelope(subjects.length, { page: 1, limit: Math.max(subjects.length, 1) }, subjects));
  }
  const all = await prisma.subject.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  res.json(envelope(all.length, { page: 1, limit: Math.max(all.length, 1) }, all));
});

// GET /exams/sections?subject_id* — section picker backing the quiz builder.
// TA: own sections only (enforced). Doctor: assigned subjects only (a prior
// listing leaked every subject's sections + TA names + seat counts).
// Admin: all sections of the subject in the current term. Students: 403.
exams.get("/sections", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ subject_id: z.string() }).parse(req.query);
  const termId = await currentTermId();
  if (!termId) return res.json(envelope(0, { page: 1, limit: 1 }, []));
  if (a.role === "doctor") {
    const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: q.subject_id, termId } });
    if (!assigned) return res.status(403).json({ error: "not assigned to subject for this term" });
  }
  const rows = await prisma.section.findMany({
    where: { subjectId: q.subject_id, termId, ...(a.role === "ta" ? { taId: a.userId } : {}) },
    select: {
      id: true, name: true,
      ta: { select: { id: true, name: true, username: true } },
      _count: { select: { memberships: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json(envelope(rows.length, { page: 1, limit: Math.max(rows.length, 1) }, rows));
});

// GET /exams/roster?subject_id* — who is in my subject: sections with their
// TA and enrolled students. Same scope rule as /sections: doctor sees only
// assigned subjects, TA only own sections, admin everything. Students: 403.
// Powers the staff Roster page (per-exam results show sittings; this shows people).
exams.get("/roster", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ subject_id: z.string() }).parse(req.query);
  const termId = await currentTermId();
  if (!termId) return res.json({ subjectId: q.subject_id, termId: null, sections: [] });
  if (a.role === "doctor") {
    const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: q.subject_id, termId } });
    if (!assigned) return res.status(403).json({ error: "not assigned to subject for this term" });
  }
  const sections = await prisma.section.findMany({
    where: { subjectId: q.subject_id, termId, ...(a.role === "ta" ? { taId: a.userId } : {}) },
    select: {
      id: true, name: true,
      ta: { select: { id: true, name: true, username: true } },
      memberships: {
        select: { student: { select: { id: true, username: true, name: true, email: true, isActive: true } } },
        orderBy: { student: { name: "asc" } },
        take: config.lists.membersMax,
      },
    },
    orderBy: { name: "asc" },
  });
  const total = await prisma.enrollment.count({ where: { subjectId: q.subject_id, termId } });
  await audit(a.userId, "roster.view", "subject", q.subject_id, { sections: sections.length }).catch(() => {});
  res.json({
    subjectId: q.subject_id,
    termId,
    totalEnrolled: total,
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      ta: s.ta,
      students: s.memberships.map((m) => m.student),
    })),
  });
});

// GET /exams/mine?term_id&status — staff's own creations.
exams.get("/mine", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = pageQuery.extend({ term_id: z.string().optional(), status: z.string().optional() }).parse(req.query);
  const termId = q.term_id ?? (await currentTermId());
  const where = { createdBy: a.userId, ...(termId ? { termId } : {}), ...(q.status ? { status: q.status as never } : {}) };
  const [total, rows] = await Promise.all([
    prisma.exam.count({ where }),
    prisma.exam.findMany({ where, orderBy: { startTime: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows));
});

// POST /exams — doctor→pending_approval, TA quiz→approved. Mix validated vs pool.
exams.post("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const body = z
    .object({
      subjectId: z.string(),
      termId: z.string().optional(),
      type: z.enum(["doctor_exam", "ta_quiz"]),
      title: z.string().trim().min(1).max(120),
      purpose: z.enum(["midterm", "quiz"]).default("quiz"),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      durationMinutes: z.number().int().positive(),
      notesEnabled: z.boolean().default(false),
      notesForDoctorEnabled: z.boolean().default(false),
      examToolsEnabled: z.boolean().default(true),
      maxReentries: z.number().int().min(0).max(20).default(3),
      resultsReleased: z.boolean().default(false),
      sebRequired: z.boolean().default(false),
      difficultyMix: mixInput.optional(),
      // Manual blueprint: hand-picked question IDs in author order (sampling
      // bypassed). Either this or a non-empty difficultyMix is required.
      manualQuestionIds: z.array(z.string().uuid()).max(200).optional(),
      targetScope: z.enum(["subject", "sections", "student_list"]),
      targetSections: z.array(z.string()).max(config.lists.examTargetsMax).optional(),
      targetStudents: z.array(z.string()).max(config.lists.examTargetsMax).optional(),
      questionSource: z.enum(["own", "shared", "mine"]).optional(),
    })
    .parse(req.body);
  const manual = [...new Set(body.manualQuestionIds ?? [])];
  if (manual.length !== (body.manualQuestionIds ?? []).length) {
    return res.status(422).json({ error: "manualQuestionIds must be unique" });
  }
  const mix = body.difficultyMix ?? {};
  if (!manual.length) {
    if (!checkMix(mix)) return res.status(422).json({ error: "difficultyMix must be {easy?,medium?,hard?} non-negative ints" });
    if (Object.values(mix).every((n) => n <= 0)) return res.status(422).json({ error: "blueprint needs a mix or hand-picked questions" });
  } else if (body.difficultyMix && !checkMix(body.difficultyMix)) {
    // Stored alongside manual blueprints: validate the shape even though
    // sampling ignores it, so no malformed ghost mix persists.
    return res.status(422).json({ error: "difficultyMix must be {easy?,medium?,hard?} non-negative ints" });
  }
  const start = new Date(body.startTime);
  const end = new Date(body.endTime);
  const windowErr = checkWindow(start, end, body.durationMinutes);
  if (windowErr) return res.status(422).json({ error: windowErr });

  const termId = body.termId ?? (await currentTermId());
  if (!termId) return res.status(409).json({ error: "no current term" });
  const subject = await prisma.subject.findUnique({ where: { id: body.subjectId }, select: { id: true } });
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const source = body.questionSource ?? (a.role === "doctor" ? "own" : "shared");

  if (a.role === "doctor") {
    if (body.type !== "doctor_exam") return res.status(403).json({ error: "doctors create doctor_exam" });
    if (!(await hasPermission(a.userId, a.role, "create_exam"))) return res.status(403).json({ error: "forbidden", need: "create_exam" });
    if (!(await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: body.subjectId, termId } }))) {
      return res.status(403).json({ error: "not assigned to subject for this term" });
    }
  }
  if (a.role === "ta") {
    if (body.type !== "ta_quiz") return res.status(403).json({ error: "TAs create ta_quiz" });
    // TAs make quizzes only — midterms are a doctor+admin affair.
    if (body.purpose !== "quiz") return res.status(403).json({ error: "TAs create quizzes only" });
    if (!(await hasPermission(a.userId, a.role, "create_quiz"))) return res.status(403).json({ error: "forbidden", need: "create_quiz" });
    if (body.targetScope !== "sections" || !body.targetSections?.length) {
      return res.status(422).json({ error: "TA quiz needs targetSections" });
    }
    // Every targeted section must be taught by this TA in this subject+term.
    const own = await prisma.section.count({
      where: { id: { in: body.targetSections }, taId: a.userId, subjectId: body.subjectId, termId },
    });
    if (own !== body.targetSections.length) return res.status(403).json({ error: "not your sections" });
  }
  // Sections scope needs real sections of THIS subject+term, for every role —
  // otherwise the exam is born unstartable (empty IN-list rejects everyone).
  if (body.targetScope === "sections") {
    if (!body.targetSections?.length) return res.status(422).json({ error: "sections scope needs targetSections" });
    const valid = await prisma.section.count({ where: { id: { in: body.targetSections }, subjectId: body.subjectId, termId } });
    if (valid !== body.targetSections.length) return res.status(422).json({ error: "targetSections must belong to this subject+term" });
  }
  if (body.targetScope === "student_list" && !body.targetStudents?.length) {
    return res.status(422).json({ error: "student_list needs targetStudents" });
  }
  if (body.targetStudents?.length) {
    const tUsers = await prisma.user.findMany({
      where: { id: { in: body.targetStudents } },
      select: { id: true, role: true },
    });
    const byId = new Map(tUsers.map((u) => [u.id, u]));
    const bad = body.targetStudents.some((id) => {
      const u = byId.get(id);
      return !u || u.role !== "student";
    });
    if (bad) return res.status(422).json({ error: "targetStudents must exist with role student" });
  }

  const pool = await poolWhere(a.userId, a.role, body.subjectId, source);
  if (!pool.ok) return res.status(422).json({ error: pool.error });
  if (!manual.length) {
    const short = mixShortfall(mix, await poolCounts(prisma, pool.where));
    if (short) return res.status(422).json({ error: "bank short for mix", ...short });
  } else {
    // Hand-picked IDs must all exist inside THIS subject and the creator's
    // own pool scope (no borrowing another bank's questions).
    const inScope = await prisma.question.count({ where: { id: { in: manual }, ...pool.where, subjectId: body.subjectId } });
    if (inScope !== manual.length) {
      return res.status(422).json({ error: "manual questions must exist in your bank for this subject" });
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    const exam = await tx.exam.create({
      data: {
        subjectId: body.subjectId,
        termId,
        type: body.type,
        createdBy: a.userId,
        // Quizzes go live immediately (no approval queue); midterms wait for
        // admin unless created by one. TAs can only reach this line as quiz.
        status: body.purpose === "quiz" || a.role === "admin" ? "approved" : "pending_approval",
        title: body.title,
        purpose: body.purpose,
        startTime: start,
        endTime: end,
        durationMinutes: body.durationMinutes,
        notesEnabled: body.notesEnabled,
        notesForDoctorEnabled: body.notesForDoctorEnabled,
        examToolsEnabled: body.examToolsEnabled,
        maxReentries: body.maxReentries,
        resultsReleased: body.resultsReleased,
        sebRequired: body.sebRequired,
        difficultyMix: mix,
        manualQuestionIds: manual.length ? manual : Prisma.DbNull,
        questionSource: a.role === "ta" ? source : "own",
        targetScope: body.targetScope,
        targetSections: body.targetSections?.length ? { create: body.targetSections.map((sectionId) => ({ sectionId })) } : undefined,
        targetStudents: body.targetStudents?.length ? { create: body.targetStudents.map((studentId) => ({ studentId })) } : undefined,
      },
    });
    return exam;
  });
  await audit(a.userId, "exam.create", "exam", row.id, { type: body.type, status: row.status });
  // Soft overlap warning (never blocks): exams sharing this subject+term and
  // window, so the author can spot double-bookings before students do.
  const warnings: string[] = [];
  try {
    const clashes = await overlappingExams(row.id, body.subjectId, termId, start, end, body.targetScope === "sections" ? (body.targetSections ?? []) : null);
    for (const c of clashes.slice(0, 3)) {
      warnings.push(`${c.title || "Untitled"} overlaps this window (${c.status})`);
    }
  } catch {
    // Warning is advisory only — creation already committed.
  }
  res.status(201).json({ ...row, warnings });
});

// Windows overlap when a.start < b.end && b.start < a.end. Same subject+term,
// both approved; optionally restricted to shared sections. Powers the soft
// creation warning and the hard one-live-midterm approval rule.
export async function overlappingExams(
  excludeId: string,
  subjectId: string,
  termId: string,
  start: Date,
  end: Date,
  sectionIds: string[] | null,
  purpose?: "midterm" | "quiz",
): Promise<{ id: string; title: string; purpose: string; status: string }[]> {
  const rows = await prisma.exam.findMany({
    where: {
      id: { not: excludeId },
      subjectId,
      termId,
      status: "approved",
      ...(purpose ? { purpose } : {}),
      startTime: { lt: end },
      endTime: { gt: start },
    },
    select: { id: true, title: true, purpose: true, status: true, targetScope: true, targetSections: { select: { sectionId: true } } },
  });
  if (!sectionIds) return rows.map(({ targetScope, targetSections, ...r }) => r);
  const wanted = new Set(sectionIds);
  return rows
    .filter((r) => r.targetScope !== "sections" || r.targetSections.some((t) => wanted.has(t.sectionId)))
    .map(({ targetScope, targetSections, ...r }) => r);
}

async function ownExamOrAdmin(userId: string, role: string, id: string) {
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam) return { error: "not found" as const };
  if (role === "admin" || exam.createdBy === userId) return { exam };
  return { error: "not yours" as const };
}

// Creator-only + create-permission gate for single-exam reads/writes.
// Non-admin must be the creator AND hold their role's create permission
// (create_exam for doctors, create_quiz for TAs); revoked creators lose access.
async function creatorPermissionError(userId: string, role: string): Promise<{ error: string; need?: string } | null> {
  if (role === "admin") return null;
  if (role === "doctor") {
    if (!(await hasPermission(userId, role as never, "create_exam"))) return { error: "forbidden", need: "create_exam" };
    return null;
  }
  if (role === "ta") {
    if (!(await hasPermission(userId, role as never, "create_quiz"))) return { error: "forbidden", need: "create_quiz" };
    return null;
  }
  return { error: "forbidden" };
}

// GET /exams/live — "happening now" strip: the caller's exams whose window is
// currently open, each with live headcounts. Admin sees everything; staff see
// only their own creations. Powers the proctoring overview; read-only.
exams.get("/live", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - config.heartbeat.staleMs);
  const exams = await prisma.exam.findMany({
    where: {
      status: "approved",
      startTime: { lte: now },
      endTime: { gte: now },
      ...(a.role === "admin" ? {} : { createdBy: a.userId }),
    },
    select: {
      id: true,
      type: true,
      status: true,
      startTime: true,
      endTime: true,
      durationMinutes: true,
      resultsReleased: true,
      subject: { select: { code: true, name: true } },
    },
    orderBy: { endTime: "asc" },
  });
  const rows = await Promise.all(
    exams.map(async (e) => {
      const [inProgress, stale, submitted] = await Promise.all([
        prisma.studentExam.count({ where: { examId: e.id, status: "in_progress" } }),
        prisma.studentExam.count({ where: { examId: e.id, status: "in_progress", OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleCutoff } }] } }),
        prisma.studentExam.count({ where: { examId: e.id, status: { in: ["submitted", "auto_submitted"] } } }),
      ]);
      return { ...e, inProgress, stale, submitted };
    }),
  );
  res.json({ now, rows });
});

exams.get("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  // Same rule as the admin detail: presence only, never the hash.
  const { accessCodeHash: _dropped, ...safe } = own.exam;
  res.json({ ...safe, hasAccessCode: _dropped !== null });
});

// GET /exams/:id/blueprint — everything about one exam on a single page:
// settings, sampling blueprint or hand-picked questions (with answers —
// creator and admin only), live sittings counts. Students: 403.
exams.get("/:id/blueprint", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  const exam = own.exam;
  const manual = Array.isArray(exam.manualQuestionIds) ? (exam.manualQuestionIds as string[]) : [];
  let questions;
  if (manual.length) {
    const rows = await prisma.question.findMany({
      where: { id: { in: manual } },
      select: { id: true, text: true, questionType: true, difficulty: true, options: true, correctAnswer: true, grade: true, imageUrl: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    questions = manual.map((id) => byId.get(id)).filter((q) => q !== undefined);
  } else {
    const pool = await poolForExam(prisma, exam);
    questions = pool.ok
      ? await prisma.question.findMany({
          where: pool.where,
          select: { id: true, text: true, questionType: true, difficulty: true, options: true, correctAnswer: true, grade: true, imageUrl: true },
          take: 50,
          orderBy: { createdAt: "desc" },
        })
      : [];
  }
  const statusCounts = await prisma.studentExam.groupBy({
    by: ["status"],
    where: { examId: exam.id },
    _count: true,
  });
  const [targetSections, targetStudentCount] = await Promise.all([
    prisma.examTargetSection.findMany({
      where: { examId: exam.id },
      select: { section: { select: { id: true, name: true } } },
    }),
    prisma.examTargetStudent.count({ where: { examId: exam.id } }),
  ]);
  const { accessCodeHash: _dropped, ...safe } = exam;
  res.json({
    exam: { ...safe, hasAccessCode: _dropped !== null },
    mode: manual.length ? "manual" : "sample",
    questions,
    targets: { sections: targetSections.map((t) => t.section), studentCount: targetStudentCount },
    sittings: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
  });
});
exams.patch("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const body = z
    .object({ title: z.string().trim().min(1).max(120).optional(), purpose: z.enum(["midterm", "quiz"]).optional(), notesEnabled: z.boolean().optional(), notesForDoctorEnabled: z.boolean().optional(), examToolsEnabled: z.boolean().optional(), maxReentries: z.number().int().min(0).max(20).optional(), resultsReleased: z.boolean().optional(), sebRequired: z.boolean().optional(), startTime: z.string().datetime().optional(), endTime: z.string().datetime().optional(), durationMinutes: z.number().int().positive().optional(), difficultyMix: mixInput.optional() })
    .parse(req.body);
  // NOTE: hand-picked blueprints lock at creation (sittings may reference
  // exact IDs) — PATCH covers window/duration/mix only, and mix patches on a
  // manual blueprint are 422 (ghost-mix guard: the mix would write but
  // sampling keeps serving manualQuestionIds).
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (own.exam.startTime.getTime() <= Date.now()) return res.status(409).json({ error: "locked", reason: "exam window has started" });
  const manual = Array.isArray(own.exam.manualQuestionIds) ? (own.exam.manualQuestionIds as string[]) : [];
  if (manual.length && body.difficultyMix) {
    return res.status(422).json({ error: "hand-picked blueprint locks difficultyMix: recreate the exam to switch modes" });
  }
  const start = body.startTime ? new Date(body.startTime) : own.exam.startTime;
  const end = body.endTime ? new Date(body.endTime) : own.exam.endTime;
  const windowErr = checkWindow(start, end, body.durationMinutes ?? own.exam.durationMinutes);
  if (windowErr) return res.status(422).json({ error: windowErr });
  if (body.difficultyMix && !checkMix(body.difficultyMix)) return res.status(422).json({ error: "bad difficultyMix" });
  // All-zero mixes are unstartable: same non-empty rule as create.
  if (body.difficultyMix && Object.values(body.difficultyMix).every((n) => n <= 0)) {
    return res.status(422).json({ error: "blueprint needs at least one question" });
  }
  if (body.difficultyMix) {
    // Same shortfall rule as create — no bypass via patch-then-grow.
    const pool = await poolForExam(prisma, own.exam);
    if (pool.ok) {
      const short = mixShortfall(body.difficultyMix, await poolCounts(prisma, pool.where));
      if (short) return res.status(422).json({ error: "bank short for mix", ...short });
    }
  }
  const row = await prisma.exam.update({
    where: { id: own.exam.id },
    // Title/purpose edits are free, but flipping purpose on an approved exam
    // re-queues it (a quiz silently becoming a midterm must not skip approval).
    data: { ...body, ...(own.exam.status === "approved" && (a.role === "doctor" || (body.purpose && body.purpose !== own.exam.purpose)) ? { status: "pending_approval" as const, approvedBy: null } : {}) },
  });
  await audit(a.userId, "exam.update", "exam", row.id, body);
  res.json(row);
});

exams.delete("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (own.exam.startTime.getTime() <= Date.now()) return res.status(409).json({ error: "locked", reason: "exam window has started" });
  // Staff exams are never born "draft" (pending_approval / approved TA quiz),
  // so draft|rejected-only would deadlock every creator. Pre-start + unapproved wins.
  const deletable =
    own.exam.status === "draft" ||
    own.exam.status === "rejected" ||
    own.exam.status === "pending_approval" ||
    (own.exam.status === "approved" && own.exam.type === "ta_quiz");
  if (!deletable) return res.status(409).json({ error: "cannot delete approved doctor exam" });
  await prisma.exam.delete({ where: { id: own.exam.id } });
  await audit(a.userId, "exam.delete", "exam", own.exam.id);
  res.json({ ok: true });
});

// POST /exams/:id/release {released} — publish or hide grades for students.
// Works ANYTIME (before, during, after the window): releasing is a visibility
// switch, not an edit. Creator (or admin) only; staff see nothing extra.
exams.post("/:id/release", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const { released } = z.object({ released: z.boolean() }).parse(req.body);
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const row = await prisma.exam.update({ where: { id: own.exam.id }, data: { resultsReleased: released } });
  await audit(a.userId, released ? "exam.release" : "exam.unrelease", "exam", row.id);
  res.json({ ok: true, resultsReleased: row.resultsReleased });
});

// GET /exams/:id/analytics — full exam intelligence for the author: hero
// aggregates, score distribution, per-question answer/skip/correct splits
// with option heatmaps and void impact, section comparison, submit timing,
// re-entry split, previous-term memory, and assigned-vs-absent counts.
// Same visibility as results (creators + permitted staff); correct answers
// and per-student rows never leave the server — only aggregates.
exams.get("/:id/analytics", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const exam = await prisma.exam.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, subjectId: true, termId: true, createdBy: true, type: true,
      startTime: true, endTime: true, durationMinutes: true, targetScope: true,
      targetSections: { select: { sectionId: true } },
      targetStudents: { select: { studentId: true } },
    },
  });
  if (!exam) return res.status(404).json({ error: "not found" });
  if (a.role !== "admin" && exam.createdBy !== a.userId) {
    if (a.role === "doctor") {
      const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: exam.subjectId, termId: exam.termId } });
      if (!assigned || !(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "not your subject" });
      }
    } else if (a.role === "ta") {
      return res.status(403).json({ error: "not your quiz" });
    }
  }
  if (a.role === "ta" && exam.createdBy === a.userId && !(await hasPermission(a.userId, a.role, "view_own_grades"))) {
    return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
  }

  const PASS = 60;
  const [sittings, memberships, sections] = await Promise.all([
    prisma.studentExam.findMany({
      where: { examId: exam.id },
      select: {
        id: true, studentId: true, status: true, startedAt: true, submittedAt: true,
        totalGrade: true, entryTokens: true,
        questions: {
          select: {
            questionId: true, selectedAnswer: true, gradeAwarded: true, isFlagged: true,
            question: { select: { text: true, questionType: true, difficulty: true, grade: true, correctAnswer: true, options: true } },
          },
        },
      },
    }),
    prisma.sectionMembership.findMany({
      where: { section: { subjectId: exam.subjectId, termId: exam.termId } },
      select: { studentId: true, sectionId: true },
    }),
    prisma.section.findMany({
      where: { subjectId: exam.subjectId, termId: exam.termId },
      select: { id: true, name: true },
    }),
  ]);
  const graded = sittings.filter((s) => s.status === "submitted" || s.status === "auto_submitted");
  const sectionOf = new Map<string, string>();
  for (const m of memberships) if (!sectionOf.has(m.studentId)) sectionOf.set(m.studentId, m.sectionId);
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));
  const pctOf = (s: (typeof graded)[number]): number | null => {
    const total = s.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0);
    if (!total) return null;
    return (Number(s.totalGrade ?? 0) / total) * 100;
  };

  // Assigned vs started vs absent.
  let assigned: number | null = null;
  if (exam.targetScope === "student_list") assigned = exam.targetStudents.length;
  else if (exam.targetScope === "sections") {
    const ids = exam.targetSections.map((t) => t.sectionId);
    assigned = await prisma.sectionMembership.count({ where: { sectionId: { in: ids } } });
  } else {
    assigned = await prisma.enrollment.count({ where: { subjectId: exam.subjectId, termId: exam.termId } });
  }
  const startedIds = new Set(sittings.map((s) => s.studentId));

  // Hero aggregates over graded sittings.
  const pcts = graded.map(pctOf).filter((p): p is number => p !== null);
  const avg = pcts.length ? pcts.reduce((x, y) => x + y, 0) / pcts.length : 0;
  const sorted = [...pcts].sort((x, y) => x - y);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const passCount = pcts.filter((p) => p >= PASS).length;
  const autoSubmitted = graded.filter((s) => s.status === "auto_submitted").length;
  let usedSum = 0, usedN = 0, rushSubmits = 0;
  for (const s of graded) {
    if (s.startedAt && s.submittedAt) {
      const mins = (s.submittedAt.getTime() - s.startedAt.getTime()) / 60000;
      usedSum += mins; usedN++;
      if (mins < exam.durationMinutes * 0.25) rushSubmits++;
    }
  }
  const distribution = Array.from({ length: 10 }, () => 0);
  for (const p of pcts) distribution[Math.min(9, Math.floor(p / 10))]++;

  // Submit curve: 12 buckets across the window.
  const submitCurve: { t: string; n: number }[] = [];
  {
    const span = exam.endTime.getTime() - exam.startTime.getTime();
    const buckets = Array.from({ length: 12 }, () => 0);
    for (const s of graded) {
      if (!s.submittedAt) continue;
      const idx = Math.min(11, Math.max(0, Math.floor(((s.submittedAt.getTime() - exam.startTime.getTime()) / span) * 12)));
      buckets[idx]++;
    }
    buckets.forEach((n, i) => {
      submitCurve.push({ t: new Date(exam.startTime.getTime() + (span * (i + 1)) / 12).toISOString(), n });
    });
  }

  // Re-entry split: one token vs several.
  const single = graded.filter((s) => s.entryTokens.length <= 1);
  const multi = graded.filter((s) => s.entryTokens.length > 1);
  const avgPct = (rows: typeof graded): number => {
    const ps = rows.map(pctOf).filter((p): p is number => p !== null);
    return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 0;
  };

  // Section comparison.
  const secAgg = new Map<string, number[]>();
  for (const s of graded) {
    const p = pctOf(s);
    if (p === null) continue;
    const sec = sectionOf.get(s.studentId);
    if (!sec) continue;
    const arr = secAgg.get(sec) ?? [];
    arr.push(p);
    secAgg.set(sec, arr);
  }
  const sectionRows = [...secAgg].map(([sectionId, ps]) => ({
    sectionId,
    name: sectionName.get(sectionId) ?? "?",
    n: ps.length,
    avg: ps.reduce((x, y) => x + y, 0) / ps.length,
    passRate: (ps.filter((p) => p >= PASS).length / ps.length) * 100,
  })).sort((x, y) => y.avg - x.avg);

  // Per-question deep stats + option heatmap + void impact.
  type QAgg = {
    text: string; type: string; difficulty: string; grade: number;
    attempts: number; answered: number; correct: number; awardSum: number; flagged: number;
    picks: Map<string, number>;
  };
  const byQ = new Map<string, QAgg>();
  for (const s of graded) {
    for (const r of s.questions) {
      let g = byQ.get(r.questionId);
      if (!g) {
        g = {
          text: r.question.text, type: r.question.questionType, difficulty: r.question.difficulty,
          grade: Number(r.question.grade ?? 0), attempts: 0, answered: 0, correct: 0, awardSum: 0, flagged: 0,
          picks: new Map(),
        };
        byQ.set(r.questionId, g);
      }
      g.attempts++;
      if (r.selectedAnswer !== null && r.selectedAnswer !== "") {
        g.answered++;
        g.picks.set(r.selectedAnswer, (g.picks.get(r.selectedAnswer) ?? 0) + 1);
        if (r.selectedAnswer === r.question.correctAnswer) g.correct++;
      }
      g.awardSum += Number(r.gradeAwarded ?? 0);
      if (r.isFlagged) g.flagged++;
    }
  }
  // Void impact: passers if everyone got full marks on this question.
  const passNow = new Set(
    graded.filter((s) => (pctOf(s) ?? 0) >= PASS).map((s) => s.id),
  );
  const voidDelta = new Map<string, number>();
  for (const [qid, g] of byQ) {
    if (!g.grade) { voidDelta.set(qid, 0); continue; }
    let now = 0;
    for (const s of graded) {
      const row = s.questions.find((q) => q.questionId === qid);
      const total = s.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0);
      if (!total) continue;
      const lifted = (Number(s.totalGrade ?? 0) - Number(row?.gradeAwarded ?? 0) + g.grade) / total * 100;
      if (lifted >= PASS && !passNow.has(s.id)) now++;
    }
    voidDelta.set(qid, now);
  }
  const questions = [...byQ].map(([questionId, g]) => {
    const labels = new Set<string>();
    for (const s of graded) {
      const row = s.questions.find((q) => q.questionId === questionId);
      const opts = row?.question.options;
      if (Array.isArray(opts)) for (const o of opts) labels.add(String(o));
    }
    for (const k of g.picks.keys()) labels.add(k);
    return {
      questionId,
      text: g.text,
      type: g.type,
      difficulty: g.difficulty,
      grade: g.grade,
      attempts: g.attempts,
      answered: g.answered,
      skipped: g.attempts - g.answered,
      correct: g.correct,
      pctCorrect: g.attempts ? Math.round((g.correct / g.attempts) * 100) : 0,
      answerRate: g.attempts ? Math.round((g.answered / g.attempts) * 100) : 0,
      avgAward: g.attempts ? Number((g.awardSum / g.attempts).toFixed(2)) : 0,
      flagged: g.flagged,
      voidPassDelta: voidDelta.get(questionId) ?? 0,
      options: [...labels].map((label) => ({ label, picks: g.picks.get(label) ?? 0 })),
    };
  }).sort((x, y) => x.pctCorrect - y.pctCorrect);

  // Previous-term memory: same subject, latest other term with submissions.
  let prevTerm: { termName: string; avg: number; passRate: number; submitted: number } | null = null;
  {
    const terms = await prisma.term.findMany({
      where: { id: { not: exam.termId } },
      select: { id: true, name: true, endsOn: true },
      orderBy: { endsOn: "desc" },
    });
    for (const t of terms) {
      const prev = await prisma.studentExam.findMany({
        where: { exam: { subjectId: exam.subjectId, termId: t.id }, status: { in: ["submitted", "auto_submitted"] } },
        select: {
          totalGrade: true,
          questions: { select: { gradeAwarded: true, question: { select: { grade: true } } } },
        },
        take: 5000,
      });
      if (!prev.length) continue;
      const ps: number[] = [];
      for (const s of prev) {
        const total = s.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0);
        if (total) ps.push((Number(s.totalGrade ?? 0) / total) * 100);
      }
      if (!ps.length) continue;
      prevTerm = {
        termName: t.name,
        avg: ps.reduce((x, y) => x + y, 0) / ps.length,
        passRate: (ps.filter((p) => p >= PASS).length / ps.length) * 100,
        submitted: prev.length,
      };
      break;
    }
  }

  await audit(a.userId, "exam.analytics", "exam", exam.id, { submitted: graded.length });
  res.json({
    examId: exam.id,
    assigned,
    started: startedIds.size,
    absent: assigned === null ? null : Math.max(0, assigned - startedIds.size),
    submitted: graded.length,
    inProgress: sittings.filter((s) => s.status === "in_progress").length,
    avg, median,
    high: sorted.length ? sorted[sorted.length - 1] : 0,
    low: sorted.length ? sorted[0] : 0,
    passRate: pcts.length ? (passCount / pcts.length) * 100 : 0,
    passCount,
    autoSubmitted,
    rushSubmits,
    avgMinutesUsed: usedN ? usedSum / usedN : 0,
    distribution,
    submitCurve,
    reentry: {
      single: { n: single.length, avg: avgPct(single) },
      multi: { n: multi.length, avg: avgPct(multi) },
    },
    sections: sectionRows,
    questions,
    prevTerm,
  });
});

// GET /exams/:id/results — doctor: all groups w/ TA names; TA: own groups only.
// Bulk grade reads are audited (who saw whose grades, when).
exams.get("/:id/results", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ limit: z.coerce.number().int().min(1).max(config.lists.resultsMax).default(500) }).parse(req.query);
  const exam = await prisma.exam.findUnique({ where: { id: String(req.params.id) }, select: { id: true, subjectId: true, termId: true, targetScope: true, createdBy: true } });
  if (!exam) return res.status(404).json({ error: "not found" });
  // Creators always see their own. Otherwise: term-scoped assignment AND the
  // view permission — a prior-term assignment alone must not open this term.
  if (a.role !== "admin" && exam.createdBy !== a.userId) {
    if (a.role === "doctor") {
      const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: exam.subjectId, termId: exam.termId } });
      if (!assigned || !(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "not your subject" });
      }
    } else if (a.role === "ta") {
      return res.status(403).json({ error: "not your quiz" });
    }
  }
  if (a.role === "ta" && exam.createdBy === a.userId && !(await hasPermission(a.userId, a.role, "view_own_grades"))) {
    return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
  }

  const sections = await prisma.section.findMany({
    // Targeted exams show only targeted sections — never the whole subject.
    where: {
      subjectId: exam.subjectId,
      termId: exam.termId,
      ...(exam.targetScope === "sections"
        ? { id: { in: (await prisma.examTargetSection.findMany({ where: { examId: exam.id }, select: { sectionId: true } })).map((t) => t.sectionId) } }
        : {}),
      ...(a.role === "ta" ? { taId: a.userId } : {}),
    },
    select: { id: true, name: true, ta: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  const groups = [];
  for (const s of sections) {
    // Full roster per section (default 500, not page 20): a 40-seat lab must
    // never silently clip students 21+. Clients may pass ?limit= for huge halls.
    const [total, memberships] = await Promise.all([
      prisma.sectionMembership.count({ where: { sectionId: s.id } }),
      prisma.sectionMembership.findMany({
        where: { sectionId: s.id },
        select: { student: { select: { id: true, username: true, name: true } } },
        orderBy: { student: { name: "asc" } },
        take: q.limit,
      }),
    ]);
    const ids = memberships.map((m) => m.student.id);
    const grades = await prisma.studentExam.findMany({
      where: { examId: exam.id, studentId: { in: ids } },
      select: { studentId: true, status: true, totalGrade: true, submittedAt: true, notesForDoctor: true, questions: { select: { question: { select: { grade: true } } } } },
    });
    const byId = new Map(grades.map((g) => [g.studentId, { ...g, totalMarks: g.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0), questions: undefined }]));
    groups.push({ sectionId: s.id, sectionName: s.name, taName: s.ta.name, total, rows: memberships.map((m) => ({ ...m.student, exam: byId.get(m.student.id) ?? null })) });
  }
  await audit(a.userId, "results.view", "exam", exam.id, { groups: groups.length, limit: q.limit });
  res.json({ examId: exam.id, groups });
});
