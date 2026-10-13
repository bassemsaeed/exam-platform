import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { storage } from "../lib/storage.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminTerms: RouterType = Router();
adminTerms.use(requireAuth, requireRole("admin"));

adminTerms.get("/", async (_req, res) => {
  res.json(await prisma.term.findMany({ orderBy: { startsOn: "desc" } }));
});

adminTerms.post("/", async (req, res) => {
  const body = z
    .object({ name: z.string().min(2), startsOn: z.string().datetime(), endsOn: z.string().datetime() })
    .refine((b) => new Date(b.startsOn) < new Date(b.endsOn), { message: "startsOn must be before endsOn" })
    .parse(req.body);
  try {
    const row = await prisma.term.create({ data: { ...body, startsOn: new Date(body.startsOn), endsOn: new Date(body.endsOn) } });
    await audit((req as unknown as AuthedRequest).userId, "term.create", "term", row.id, body);
    res.status(201).json(row);
  } catch (e) {
    // Name collisions are 409; everything else (validation, connection)
    // must surface honestly, not masquerade as "term exists".
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "term exists" });
    }
    throw e;
  }
});

// Exactly one current term — imports and student lists target this.
adminTerms.post("/:id/make-current", async (req, res) => {
  const term = await prisma.term.findUnique({ where: { id: req.params.id } });
  if (!term) return res.status(404).json({ error: "not found" });
  await prisma.$transaction([
    prisma.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } }),
    prisma.term.update({ where: { id: term.id }, data: { isCurrent: true } }),
  ]);
  await audit((req as unknown as AuthedRequest).userId, "term.make-current", "term", term.id);
  res.json({ ok: true, current: term.id });
});

// Term refresh wipe: roster + exam data for THIS term only. Banks survive.
adminTerms.post("/:id/wipe", async (req, res) => {
  const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body);
  void confirm;
  const term = await prisma.term.findUnique({ where: { id: req.params.id } });
  if (!term) return res.status(404).json({ error: "not found" });
  if (term.isCurrent) return res.status(409).json({ error: "cannot wipe current term" });
  // Live sittings are evidence in motion: wiping mid-exam strands students
  // and destroys grades. Close or wait out the window first.
  const live = await prisma.studentExam.count({ where: { exam: { termId: term.id }, status: "in_progress" } });
  if (live > 0) return res.status(409).json({ error: "term has live exam sittings", live });
  // Collect this term's export jobs first: the rows die in the tx below, and
  // the files must follow (otherwise every wipe leaks disk/S3 objects).
  // Term-scoped two ways: jobs on term exams, plus term-wide jobs whose
  // term_id lives in params JSON.
  const allJobs = await prisma.exportJob.findMany({
    select: { id: true, params: true, exam: { select: { termId: true } } },
  });
  const termJobs = allJobs.filter((j) => {
    const p = ((j.params ?? {}) as { term_id?: string; termId?: string });
    const pTerm = p.termId ?? p.term_id;
    return j.exam?.termId === term.id || pTerm === term.id;
  });
  const termJobIds = termJobs.map((j) => j.id);
  const r = await prisma.$transaction([
    prisma.studentExamQuestion.deleteMany({ where: { studentExam: { exam: { termId: term.id } } } }),
    prisma.studentExam.deleteMany({ where: { exam: { termId: term.id } } }),
    prisma.examEvent.deleteMany({ where: { exam: { termId: term.id } } }),
    prisma.examCompensation.deleteMany({ where: { exam: { termId: term.id } } }),
    prisma.examTargetSection.deleteMany({ where: { exam: { termId: term.id } } }),
    prisma.examTargetStudent.deleteMany({ where: { exam: { termId: term.id } } }),
    prisma.exportJob.deleteMany({ where: { id: { in: termJobIds } } }),
    prisma.exam.deleteMany({ where: { termId: term.id } }),
    prisma.sectionMembership.deleteMany({ where: { section: { termId: term.id } } }),
    prisma.section.deleteMany({ where: { termId: term.id } }),
    prisma.enrollment.deleteMany({ where: { termId: term.id } }),
    prisma.doctorAssignment.deleteMany({ where: { termId: term.id } }),
  ]);
  const deleted = r.reduce((n, x) => n + x.count, 0);
  let filesRemoved = 0;
  for (const j of termJobs) {
    const key = ((j.params ?? {}) as { fileKey?: string }).fileKey;
    if (!key) continue;
    try {
      await storage.delete(key);
      filesRemoved++;
    } catch {
      // best-effort: rows are the source of truth, files are garbage to sweep
    }
  }
  await audit((req as unknown as AuthedRequest).userId, "term.wipe", "term", term.id, { deleted, filesRemoved });
  res.json({ ok: true, deleted, filesRemoved });
});
