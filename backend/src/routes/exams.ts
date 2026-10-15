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
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      durationMinutes: z.number().int().positive(),
      notesEnabled: z.boolean().default(false),
      notesForDoctorEnabled: z.boolean().default(false),
      examToolsEnabled: z.boolean().default(true),
      maxReentries: z.number().int().min(0).max(20).default(3),
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
        status: a.role === "ta" ? "approved" : a.role === "admin" ? "approved" : "pending_approval",
        startTime: start,
        endTime: end,
        durationMinutes: body.durationMinutes,
        notesEnabled: body.notesEnabled,
        notesForDoctorEnabled: body.notesForDoctorEnabled,
        examToolsEnabled: body.examToolsEnabled,
        maxReentries: body.maxReentries,
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
  res.status(201).json(row);
});

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
    .object({ notesEnabled: z.boolean().optional(), notesForDoctorEnabled: z.boolean().optional(), examToolsEnabled: z.boolean().optional(), maxReentries: z.number().int().min(0).max(20).optional(), startTime: z.string().datetime().optional(), endTime: z.string().datetime().optional(), durationMinutes: z.number().int().positive().optional(), difficultyMix: mixInput.optional() })
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
    data: { ...body, ...(own.exam.status === "approved" && a.role === "doctor" ? { status: "pending_approval" as const, approvedBy: null } : {}) },
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
