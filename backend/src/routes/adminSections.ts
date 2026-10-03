import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminSections: RouterType = Router();
adminSections.use(requireAuth, requireRole("admin"));

// GET /api/v1/admin/sections?subject_id&term_id&ta_id&search
adminSections.get("/", async (req, res) => {
  const q = pageQuery.extend({ subject_id: z.string().optional(), term_id: z.string().optional(), ta_id: z.string().optional(), search: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.subject_id ? { subjectId: q.subject_id } : {}),
    ...(q.term_id ? { termId: q.term_id } : {}),
    ...(q.ta_id ? { taId: q.ta_id } : {}),
    ...(q.search?.trim() ? { name: { contains: q.search.trim(), mode: "insensitive" as const } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.section.count({ where }),
    prisma.section.findMany({
      where,
      select: {
        id: true, name: true, subjectId: true, termId: true, taId: true,
        subject: { select: { code: true, name: true } },
        ta: { select: { name: true, username: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: { name: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

adminSections.post("/", async (req, res) => {
  const body = z.object({ subjectId: z.string(), termId: z.string(), taId: z.string(), name: z.string().min(1) }).parse(req.body);
  const ta = await prisma.user.findUnique({ where: { id: body.taId }, select: { role: true } });
  if (!ta || ta.role !== "ta") return res.status(422).json({ error: "ta_id must be a TA" });
  // Reject dangling references with 400 here instead of a raw FK 500: any
  // term (including past/wiped) is accepted — the caller owns that choice.
  const [subject, term] = await Promise.all([
    prisma.subject.count({ where: { id: body.subjectId } }),
    prisma.term.count({ where: { id: body.termId } }),
  ]);
  if (!subject || !term) return res.status(400).json({ error: "invalid subject or term" });
  const row = await prisma.section.create({ data: body });
  await audit((req as unknown as AuthedRequest).userId, "section.create", "section", row.id, body);
  res.status(201).json(row);
});

adminSections.patch("/:id", async (req, res) => {
  const body = z.object({ taId: z.string().optional(), name: z.string().min(1).optional() }).parse(req.body);
  // Same invariant as create: a section must be owned by a TA (never a
  // student/doctor), or TA-quiz ownership checks break downstream.
  if (body.taId) {
    const ta = await prisma.user.findUnique({ where: { id: body.taId }, select: { role: true } });
    if (!ta || ta.role !== "ta") return res.status(422).json({ error: "ta_id must be a TA" });
  }
  const row = await prisma.section.update({ where: { id: req.params.id }, data: body });
  await audit((req as unknown as AuthedRequest).userId, "section.update", "section", row.id, body);
  res.json(row);
});

adminSections.delete("/:id", async (req, res) => {
  const used = await prisma.examTargetSection.count({ where: { sectionId: req.params.id } });
  if (used > 0) return res.status(409).json({ error: "section targeted by exams" });
  await prisma.$transaction([
    prisma.sectionMembership.deleteMany({ where: { sectionId: req.params.id } }),
    prisma.section.delete({ where: { id: req.params.id } }),
  ]);
  await audit((req as unknown as AuthedRequest).userId, "section.delete", "section", req.params.id);
  res.json({ ok: true });
});

// GET members with user rows (narrow select — never password/account).
// Reports the true total + truncation so large rosters never render
// silently incomplete.
adminSections.get("/:id/members", async (req, res) => {
  const [total, rows] = await Promise.all([
    prisma.sectionMembership.count({ where: { sectionId: req.params.id } }),
    prisma.sectionMembership.findMany({
      where: { sectionId: req.params.id },
      select: { student: { select: { id: true, username: true, name: true } } },
      take: config.lists.membersMax,
    }),
  ]);
  res.json({ total, truncated: total > rows.length, rows: rows.map((r) => r.student) });
});

// POST {add:[studentIds], remove:[studentIds]} — add also ensures subject+term enrollment
adminSections.post("/:id/members", async (req, res) => {
  const body = z
    .object({ add: z.array(z.string()).max(config.lists.membersMax).default([]), remove: z.array(z.string()).max(config.lists.membersMax).default([]) })
    .parse(req.body);
  const sec = await prisma.section.findUnique({ where: { id: req.params.id } });
  if (!sec) return res.status(404).json({ error: "not found" });
  // Remove wins over add for overlapping IDs: otherwise the add-upsert +
  // remove-delete net-deletes the seat but still mints a stray enrollment.
  const removeSet = new Set(body.remove);
  const add = body.add.filter((id) => !removeSet.has(id));
  // Membership is for students only — staff ids would fabricate enrollments.
  // Unknown IDs 422 with the culprits listed instead of aborting the whole
  // transaction on a raw FK error.
  if (add.length) {
    const found = await prisma.user.findMany({ where: { id: { in: add } }, select: { id: true, role: true } });
    const foundIds = new Set(found.map((u) => u.id));
    const invalid = add.filter((id) => !foundIds.has(id));
    if (invalid.length) return res.status(422).json({ error: "unknown user ids", invalid });
    if (found.some((u) => u.role !== "student")) return res.status(422).json({ error: "members must be students" });
    const size = await prisma.sectionMembership.count({ where: { sectionId: sec.id } });
    if (size + add.length > config.lists.membersMax) {
      return res.status(422).json({ error: "section is full", capacity: config.lists.membersMax });
    }
  }
  await prisma.$transaction([
    ...add.map((studentId) =>
      prisma.sectionMembership.upsert({
        where: { studentId_sectionId: { studentId, sectionId: sec.id } },
        update: {},
        create: { studentId, sectionId: sec.id },
      }),
    ),
    ...add.map((studentId) =>
      prisma.enrollment.upsert({
        where: { studentId_subjectId_termId: { studentId, subjectId: sec.subjectId, termId: sec.termId } },
        update: {},
        create: { studentId, subjectId: sec.subjectId, termId: sec.termId },
      }),
    ),
    prisma.sectionMembership.deleteMany({ where: { sectionId: sec.id, studentId: { in: body.remove } } }),
  ]);
  // Coherence: a removed student with no other seat in this subject+term
  // loses the auto-created enrollment too — otherwise section and enrollment
  // checks disagree on eligibility.
  if (body.remove.length) {
    const stillSeated = await prisma.sectionMembership.findMany({
      where: {
        studentId: { in: body.remove },
        section: { subjectId: sec.subjectId, termId: sec.termId },
      },
      select: { studentId: true },
    });
    const seated = new Set(stillSeated.map((m) => m.studentId));
    const orphaned = body.remove.filter((id) => !seated.has(id));
    if (orphaned.length) {
      await prisma.enrollment.deleteMany({
        where: { studentId: { in: orphaned }, subjectId: sec.subjectId, termId: sec.termId },
      });
    }
  }
  await audit((req as unknown as AuthedRequest).userId, "section.members", "section", sec.id, body);
  res.json({ ok: true, added: add.length, removed: body.remove.length });
});
