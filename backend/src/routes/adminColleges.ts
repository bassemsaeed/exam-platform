import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminColleges: RouterType = Router();
adminColleges.use(requireAuth, requireRole("admin"));

const codeRule = z.string().min(2).max(20).regex(/^[a-zA-Z0-9_.-]+$/);

// Case-insensitive duplicate check (base uniques are case-sensitive —
// "Engineering" vs "engineering" must not fork a college; lower() unique
// indexes in 20261016130000_college_ci_unique close the check-then-insert race
// with a 409 via P2002).
async function dupeName(name: string, excludeId?: string) {
  return prisma.college.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
}

// GET /api/v1/admin/colleges — cards with headcounts.
adminColleges.get("/", async (req, res) => {
  const q = pageQuery.extend({ search: z.string().optional() }).parse(req.query);
  const where = q.search
    ? { OR: [{ code: { contains: q.search, mode: "insensitive" as const } }, { name: { contains: q.search, mode: "insensitive" as const } }] }
    : {};
  const [total, rows] = await Promise.all([
    prisma.college.count({ where }),
    prisma.college.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        createdAt: true,
        _count: { select: { departments: true } },
      },
      orderBy: { name: "asc" },
      ...page(q),
    }),
  ]);
  const ids = rows.map((r) => r.id);
  const [students, doctors] = await Promise.all([
    prisma.user.groupBy({ by: ["collegeId"], where: { collegeId: { in: ids }, role: "student" }, _count: true }),
    prisma.user.groupBy({ by: ["collegeId"], where: { collegeId: { in: ids }, role: "doctor" }, _count: true }),
  ]);
  const sBy = new Map(students.map((g) => [g.collegeId, g._count]));
  const dBy = new Map(doctors.map((g) => [g.collegeId, g._count]));
  res.json(envelope(total, q, rows.map((r) => ({ id: r.id, code: r.code, name: r.name, createdAt: r.createdAt, departments: r._count.departments, students: sBy.get(r.id) ?? 0, doctors: dBy.get(r.id) ?? 0 }))));
});

adminColleges.post("/", async (req, res) => {
  const body = z.object({ code: codeRule, name: z.string().trim().min(2).max(120) }).parse(req.body);
  if (await dupeName(body.name)) return res.status(409).json({ error: "college name already exists" });
  try {
    const row = await prisma.college.create({ data: { code: body.code.toUpperCase(), name: body.name } });
    await audit((req as unknown as AuthedRequest).userId, "college.create", "college", row.id, body);
    res.status(201).json(row);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "college already exists" });
    }
    throw e;
  }
});

// GET /api/v1/admin/colleges/students/search?q= — global student lookup.
// Registered BEFORE /:id so "search" never parses as an id.
adminColleges.get("/students/search", async (req, res) => {
  const q = z.object({ q: z.string().trim().min(1).max(120) }).parse(req.query);
  const rows = await prisma.user.findMany({
    where: {
      role: "student",
      OR: [
        { username: { contains: q.q, mode: "insensitive" as const } },
        { name: { contains: q.q, mode: "insensitive" as const } },
        { email: { contains: q.q, mode: "insensitive" as const } },
      ],
    },
    select: {
      id: true, username: true, name: true, email: true, isActive: true,
      academicYear: true, department: { select: { name: true } },
      collegeRef: { select: { id: true, name: true } },
    },
    orderBy: { name: "asc" },
    take: 50,
  });
  res.json(rows);
});

// GET /api/v1/admin/colleges/:id — info, counts, departments, years present.
adminColleges.get("/:id", async (req, res) => {
  const row = await prisma.college.findUnique({
    where: { id: String(req.params.id) },
    include: {
      departments: { select: { id: true, code: true, name: true, _count: { select: { users: true, subjects: true } } }, orderBy: { code: "asc" } },
    },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  const [students, doctors, years] = await Promise.all([
    prisma.user.count({ where: { collegeId: row.id, role: "student" } }),
    prisma.user.count({ where: { collegeId: row.id, role: "doctor" } }),
    prisma.user.groupBy({ by: ["academicYear"], where: { collegeId: row.id, role: "student", academicYear: { not: null } }, _count: true, orderBy: { academicYear: "asc" } }),
  ]);
  res.json({
    ...row,
    students,
    doctors,
    years: years.map((g) => ({ year: g.academicYear, students: g._count })),
  });
});

adminColleges.patch("/:id", async (req, res) => {
  const body = z.object({ code: codeRule.optional(), name: z.string().trim().min(2).max(120).optional() }).parse(req.body);
  const me = (req as unknown as AuthedRequest).userId;
  const row = await prisma.college.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!row) return res.status(404).json({ error: "not found" });
  if (body.name && (await dupeName(body.name, row.id))) return res.status(409).json({ error: "college name already exists" });
  const data: Record<string, unknown> = { ...body };
  if (typeof data["code"] === "string") data["code"] = (data["code"] as string).toUpperCase();
  try {
    const updated = await prisma.college.update({ where: { id: row.id }, data: data as never });
    await audit(me, "college.update", "college", row.id, body);
    res.json(updated);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "college already exists" });
    }
    throw e;
  }
});

adminColleges.delete("/:id", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const id = String(req.params.id);
  const linked = await prisma.college.findUnique({
    where: { id },
    select: { _count: { select: { departments: true, users: true } } },
  });
  if (!linked) return res.status(404).json({ error: "not found" });
  if (linked._count.departments > 0 || linked._count.users > 0) {
    return res.status(409).json({
      error: "college still has members — merge or reassign them first",
      departments: linked._count.departments,
      users: linked._count.users,
    });
  }
  // Re-check inside the write transaction: a member linked between the guard
  // above and the delete must not orphan via SET NULL.
  try {
    await prisma.$transaction(async (tx) => {
      const cur = await tx.college.findUnique({
        where: { id },
        select: { _count: { select: { departments: true, users: true } } },
      });
      if (!cur) throw Object.assign(new Error("not found"), { status: 404 });
      if (cur._count.departments > 0 || cur._count.users > 0) {
        throw Object.assign(new Error("college still has members — merge or reassign them first"), {
          status: 409,
          departments: cur._count.departments,
          users: cur._count.users,
        });
      }
      await tx.college.delete({ where: { id } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ error: "not found" });
    }
    if (e && typeof e === "object" && "status" in e) {
      const s = e as { status: number; message: string; departments?: number; users?: number };
      if (s.status === 404) return res.status(404).json({ error: "not found" });
      if (s.status === 409) {
        return res.status(409).json({ error: s.message, departments: s.departments, users: s.users });
      }
    }
    throw e;
  }
  await audit(me, "college.delete", "college", id);
  res.json({ ok: true });
});

// POST /api/v1/admin/colleges/:id/merge {intoId} — fold a duplicate (usually
// a typo variant) into the canonical college: move departments + users, then
// delete the source. Atomic; audited with moved counts.
adminColleges.post("/:id/merge", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const { intoId } = z.object({ intoId: z.string().uuid() }).parse(req.body);
  const id = String(req.params.id);
  if (intoId === id) return res.status(422).json({ error: "cannot merge a college into itself" });
  const [src, dst] = await Promise.all([
    prisma.college.findUnique({ where: { id }, select: { id: true, name: true } }),
    prisma.college.findUnique({ where: { id: intoId }, select: { id: true, name: true } }),
  ]);
  if (!src || !dst) return res.status(404).json({ error: "college not found" });
  try {
    const out = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction: either side may have vanished after
      // the fast pre-check above.
      const s = await tx.college.findUnique({ where: { id }, select: { id: true } });
      const d = await tx.college.findUnique({ where: { id: intoId }, select: { id: true, name: true } });
      if (!s || !d) throw Object.assign(new Error("college not found"), { status: 404 });
      const depts = await tx.department.updateMany({ where: { collegeId: id }, data: { collegeId: intoId } });
      // Keep the legacy free-text column in sync with the canonical name so
      // reads that still show `college` (e.g. admin user lists) stop showing
      // the folded typo after the merge.
      const users = await tx.user.updateMany({ where: { collegeId: id }, data: { collegeId: intoId, college: d.name } });
      await tx.college.delete({ where: { id } });
      return { departments: depts.count, users: users.count };
    });
    await audit(me, "college.merge", "college", intoId, { from: { id: src.id, name: src.name }, ...out });
    res.json({ ok: true, intoId, ...out });
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) {
      return res.status(404).json({ error: "college not found" });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2025" || e.code === "P2003")) {
      return res.status(404).json({ error: "college not found" });
    }
    throw e;
  }
});

// GET /api/v1/admin/colleges/:id/students?year&search — enrolled students.
adminColleges.get("/:id/students", async (req, res) => {
  const q = pageQuery
    .extend({ year: z.coerce.number().int().min(1).max(7).optional(), search: z.string().optional() })
    .parse(req.query);
  const college = await prisma.college.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!college) return res.status(404).json({ error: "not found" });
  const where = {
    collegeId: college.id,
    role: "student" as const,
    ...(q.year ? { academicYear: q.year } : {}),
    ...(q.search?.trim()
      ? {
          OR: [
            { username: { contains: q.search.trim(), mode: "insensitive" as const } },
            { name: { contains: q.search.trim(), mode: "insensitive" as const } },
            { email: { contains: q.search.trim(), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true, username: true, name: true, email: true, isActive: true,
        academicYear: true, department: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

// POST /api/v1/admin/colleges/:id/students/year {studentIds[1..500], year} —
// bulk cohort set. Every id must be a student OF THIS college, else 422 and
// nothing writes (no partial cross-college moves).
adminColleges.post("/:id/students/year", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ studentIds: z.array(z.string()).min(1).max(500), year: z.number().int().min(1).max(7) }).parse(req.body);
  const college = await prisma.college.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!college) return res.status(404).json({ error: "not found" });
  const ids = [...new Set(body.studentIds)];
  const updated = await prisma.$transaction(async (tx) => {
    const matched = await tx.user.count({
      where: { id: { in: ids }, collegeId: college.id, role: "student" },
    });
    if (matched !== ids.length) {
      throw Object.assign(new Error("every id must be a student of this college"), { status: 422 });
    }
    // Fail-closed write guard: the college filter stays on the write itself so
    // a concurrent move between the count and the update cannot leak a
    // cross-college year-set.
    return tx.user.updateMany({
      where: { id: { in: ids }, collegeId: college.id, role: "student" },
      data: { academicYear: body.year },
    });
  }).catch((e) => {
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 422) {
      return null;
    }
    throw e;
  });
  if (!updated) {
    return res.status(422).json({ error: "every id must be a student of this college" });
  }
  await audit(me, "college.bulk-year", "college", college.id, { year: body.year, count: updated.count });
  res.json({ ok: true, count: updated.count });
});
