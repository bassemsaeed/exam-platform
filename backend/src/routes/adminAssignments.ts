import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

// Admin-managed academic bindings: doctors ↔ subjects (per term), students ↔
// subjects (enrollments, per term). TA ↔ section binding lives on
// /admin/sections (taId); department membership lives on /admin/users.
export const adminAssignments: RouterType = Router();
adminAssignments.use(requireAuth, requireRole("admin"));

// --- Doctor assignments ---

adminAssignments.get("/doctors", async (req, res) => {
  const q = pageQuery.extend({ subject_id: z.string().optional(), term_id: z.string().optional(), doctor_id: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.subject_id ? { subjectId: q.subject_id } : {}),
    ...(q.term_id ? { termId: q.term_id } : {}),
    ...(q.doctor_id ? { doctorId: q.doctor_id } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.doctorAssignment.count({ where }),
    prisma.doctorAssignment.findMany({
      where,
      select: {
        doctorId: true, subjectId: true, termId: true,
        doctor: { select: { id: true, username: true, name: true } },
        subject: { select: { id: true, code: true, name: true } },
        term: { select: { id: true, name: true } },
      },
      orderBy: { subjectId: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

adminAssignments.post("/doctors", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ doctorId: z.string(), subjectId: z.string(), termId: z.string() }).parse(req.body);
  const doctor = await prisma.user.findUnique({ where: { id: body.doctorId }, select: { role: true } });
  if (!doctor || doctor.role !== "doctor") return res.status(422).json({ error: "doctorId must be a doctor" });
  const [subject, term] = await Promise.all([
    prisma.subject.count({ where: { id: body.subjectId } }),
    prisma.term.count({ where: { id: body.termId } }),
  ]);
  if (!subject || !term) return res.status(400).json({ error: "invalid subject or term" });
  const row = await prisma.doctorAssignment.upsert({
    where: { doctorId_subjectId_termId: body },
    update: {},
    create: body,
  });
  await audit(me, "doctor.assign", "doctor_assignment", `${body.doctorId}:${body.subjectId}:${body.termId}`, body);
  res.status(201).json(row);
});

adminAssignments.delete("/doctors", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ doctorId: z.string(), subjectId: z.string(), termId: z.string() }).parse(req.body);
  await prisma.doctorAssignment.delete({ where: { doctorId_subjectId_termId: body } });
  await audit(me, "doctor.unassign", "doctor_assignment", `${body.doctorId}:${body.subjectId}:${body.termId}`, body);
  res.json({ ok: true });
});

// --- Enrollments (students ↔ subjects, per term) ---

adminAssignments.get("/enrollments", async (req, res) => {
  const q = pageQuery.extend({ subject_id: z.string().optional(), term_id: z.string().optional(), student_id: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.subject_id ? { subjectId: q.subject_id } : {}),
    ...(q.term_id ? { termId: q.term_id } : {}),
    ...(q.student_id ? { studentId: q.student_id } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.enrollment.count({ where }),
    prisma.enrollment.findMany({
      where,
      select: {
        studentId: true, subjectId: true, termId: true,
        student: { select: { id: true, username: true, name: true } },
        subject: { select: { id: true, code: true, name: true } },
        term: { select: { id: true, name: true } },
      },
      orderBy: { subjectId: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

adminAssignments.post("/enrollments", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ studentId: z.string(), subjectId: z.string(), termId: z.string() }).parse(req.body);
  const stu = await prisma.user.findUnique({ where: { id: body.studentId }, select: { role: true } });
  if (!stu || stu.role !== "student") return res.status(422).json({ error: "studentId must be a student" });
  const [subject, term] = await Promise.all([
    prisma.subject.count({ where: { id: body.subjectId } }),
    prisma.term.count({ where: { id: body.termId } }),
  ]);
  if (!subject || !term) return res.status(400).json({ error: "invalid subject or term" });
  const row = await prisma.enrollment.upsert({
    where: { studentId_subjectId_termId: body },
    update: {},
    create: body,
  });
  await audit(me, "enrollment.assign", "enrollment", `${body.studentId}:${body.subjectId}:${body.termId}`, body);
  res.status(201).json(row);
});

adminAssignments.delete("/enrollments", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ studentId: z.string(), subjectId: z.string(), termId: z.string() }).parse(req.body);
  // Coherence (mirror of section-remove): dropping the enrollment also drops
  // the student's section seats in this subject+term — a sectionless
  // enrollment and an enrollmentless seat disagree on eligibility.
  await prisma.$transaction([
    prisma.sectionMembership.deleteMany({
      where: { studentId: body.studentId, section: { subjectId: body.subjectId, termId: body.termId } },
    }),
    prisma.enrollment.delete({ where: { studentId_subjectId_termId: body } }),
  ]);
  await audit(me, "enrollment.unassign", "enrollment", `${body.studentId}:${body.subjectId}:${body.termId}`, body);
  res.json({ ok: true });
});
