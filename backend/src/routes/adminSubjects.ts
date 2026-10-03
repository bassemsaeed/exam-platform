import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminSubjects: RouterType = Router();
adminSubjects.use(requireAuth, requireRole("admin"));

adminSubjects.get("/", async (req, res) => {
  const q = pageQuery.extend({ search: z.string().optional() }).parse(req.query);
  const where = q.search?.trim()
    ? { OR: [{ code: { contains: q.search.trim(), mode: "insensitive" as const } }, { name: { contains: q.search.trim(), mode: "insensitive" as const } }] }
    : {};
  const [total, rows] = await Promise.all([
    prisma.subject.count({ where }),
    prisma.subject.findMany({
      where,
      select: { id: true, code: true, name: true, department: { select: { code: true } } },
      orderBy: { code: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

adminSubjects.post("/", async (req, res) => {
  const body = z.object({ code: z.string().min(2).max(20).regex(/^[a-zA-Z0-9_.-]+$/), name: z.string().min(2), departmentId: z.string().nullable().optional() }).parse(req.body);
  // Unique/FK violations map in the global handler (P2002→409, P2003→400).
  const row = await prisma.subject.create({ data: body });
  await audit((req as unknown as AuthedRequest).userId, "subject.create", "subject", row.id, body);
  res.status(201).json(row);
});

adminSubjects.get("/:id", async (req, res) => {
  const row = await prisma.subject.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { enrollments: true, sections: true, questions: true, exams: true } } },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

adminSubjects.patch("/:id", async (req, res) => {
  const body = z.object({ code: z.string().min(2).max(20).regex(/^[a-zA-Z0-9_.-]+$/).optional(), name: z.string().min(2).optional(), departmentId: z.string().nullable().optional() }).parse(req.body);
  const row = await prisma.subject.update({ where: { id: req.params.id }, data: body });
  await audit((req as unknown as AuthedRequest).userId, "subject.update", "subject", row.id, body);
  res.json(row);
});

adminSubjects.delete("/:id", async (req, res) => {
  const used = await prisma.exam.count({ where: { subjectId: req.params.id } });
  if (used > 0) return res.status(409).json({ error: "subject has exams" });
  try {
    await prisma.$transaction([
      prisma.enrollment.deleteMany({ where: { subjectId: req.params.id } }),
      prisma.doctorAssignment.deleteMany({ where: { subjectId: req.params.id } }),
      prisma.section.deleteMany({ where: { subjectId: req.params.id } }),
      prisma.question.deleteMany({ where: { subjectId: req.params.id } }),
      prisma.subject.delete({ where: { id: req.params.id } }),
    ]);
  } catch (e) {
    // Sampled sittings and compensations hold Restrict references: the
    // subject is grade history, not just catalog data.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return res.status(409).json({ error: "subject in use by exams or compensations" });
    }
    throw e;
  }
  await audit((req as unknown as AuthedRequest).userId, "subject.delete", "subject", req.params.id);
  res.json({ ok: true });
});
