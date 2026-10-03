import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminDepartments: RouterType = Router();
adminDepartments.use(requireAuth, requireRole("admin"));

// GET /api/v1/admin/departments — catalog with member/subject counts.
adminDepartments.get("/", async (req, res) => {
  const q = pageQuery.extend({ search: z.string().optional() }).parse(req.query);
  const where = q.search
    ? { OR: [{ code: { contains: q.search, mode: "insensitive" as const } }, { name: { contains: q.search, mode: "insensitive" as const } }] }
    : {};
  const [total, rows] = await Promise.all([
    prisma.department.count({ where }),
    prisma.department.findMany({
      where,
      select: { id: true, code: true, name: true, _count: { select: { users: true, subjects: true } } },
      orderBy: { code: "asc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

adminDepartments.post("/", async (req, res) => {
  const body = z.object({ code: z.string().min(2).max(20).regex(/^[a-zA-Z0-9_.-]+$/), name: z.string().min(2).max(200) }).parse(req.body);
  const row = await prisma.department.create({ data: { code: body.code.toUpperCase(), name: body.name.trim() } });
  await audit((req as unknown as AuthedRequest).userId, "department.create", "department", row.id, body);
  res.status(201).json(row);
});

adminDepartments.get("/:id", async (req, res) => {
  const row = await prisma.department.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { users: true, subjects: true } },
      subjects: { select: { id: true, code: true, name: true } },
    },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  const [memberTotal, members] = await Promise.all([
    prisma.user.count({ where: { departmentId: row.id } }),
    prisma.user.findMany({
      where: { departmentId: row.id },
      select: { id: true, username: true, name: true, role: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
  ]);
  res.json({ ...row, members, memberTotal, membersTruncated: memberTotal > members.length });
});

adminDepartments.patch("/:id", async (req, res) => {
  const body = z.object({ code: z.string().min(2).max(20).regex(/^[a-zA-Z0-9_.-]+$/).optional(), name: z.string().min(2).max(200).optional() }).parse(req.body);
  const data: Record<string, unknown> = { ...body };
  if (typeof data["code"] === "string") data["code"] = (data["code"] as string).toUpperCase();
  const row = await prisma.department.update({ where: { id: req.params.id }, data: data as never });
  await audit((req as unknown as AuthedRequest).userId, "department.update", "department", row.id, body);
  res.json(row);
});

adminDepartments.delete("/:id", async (req, res) => {
  // SetNull on users/subjects: members become unassigned, catalog row goes.
  const linked = await prisma.department.findUnique({ where: { id: req.params.id }, select: { _count: { select: { users: true, subjects: true } } } });
  if (!linked) return res.status(404).json({ error: "not found" });
  const row = await prisma.department.delete({ where: { id: req.params.id } });
  await audit((req as unknown as AuthedRequest).userId, "department.delete", "department", req.params.id, { unlinkedUsers: linked._count.users, unlinkedSubjects: linked._count.subjects });
  void row;
  res.json({ ok: true });
});
