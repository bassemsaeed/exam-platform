import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { isPeerAdmin } from "../lib/domain.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminUsers: RouterType = Router();
adminUsers.use(requireAuth, requireRole("admin"));

// GET /api/v1/admin/users?role&search&active&page&limit
adminUsers.get("/", async (req, res) => {
  const q = pageQuery.extend({ role: z.string().optional(), search: z.string().optional(), active: z.string().optional(), department_id: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.role ? { role: q.role as never } : {}),
    ...(q.active === "true" ? { isActive: true } : q.active === "false" ? { isActive: false } : {}),
    ...(q.department_id ? { departmentId: q.department_id } : {}),
    ...(q.search ? { OR: [{ username: { contains: q.search, mode: "insensitive" as const } }, { name: { contains: q.search, mode: "insensitive" as const } }, { email: { contains: q.search, mode: "insensitive" as const } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: { id: true, username: true, name: true, email: true, role: true, isActive: true, canChangePassword: true, departmentId: true, department: { select: { id: true, code: true, name: true } }, academicYear: true, college: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});

// POST /api/v1/admin/users — single-user creation (the Excel import covers
// bulk). Same validation as import rows; password hashed before storing.
// Admins create doctors/TAs/students only — peer-admin creation is forbidden
// (no privilege escalation between admins). Atomic: user + credential in one
// transaction so a crash can never orphan a username without a login.
adminUsers.post("/", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({
    username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(config.password.minLength),
    name: z.string().min(1).max(200),
    role: z.enum(["doctor", "ta", "student"]),
    email: z.string().email().max(320).optional(),
    academicYear: z.number().int().min(1).max(7).nullable().optional(),
    college: z.string().trim().max(120).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);
  const username = body.username.toLowerCase();
  const email = (body.email ?? `${username}@${config.email.placeholderDomain}`).toLowerCase();
  if (body.departmentId) {
    const dept = await prisma.department.count({ where: { id: body.departmentId } });
    if (!dept) return res.status(400).json({ error: "invalid reference", field: "departmentId" });
  }
  const clash = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } });
  if (clash) return res.status(409).json({ error: "username or email taken" });
  const { hashPassword } = await import("better-auth/crypto");
  const hashed = await hashPassword(body.password);
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        id: `u_${username}`,
        name: body.name.trim(),
        email,
        emailVerified: false,
        username,
        role: body.role as never,
        canChangePassword: body.role !== "student",
        isActive: true,
        academicYear: body.academicYear ?? null,
        college: body.college?.trim() || null,
        departmentId: body.departmentId ?? null,
      },
    });
    await tx.account.create({
      data: { id: `acc-${u.id}`, providerId: "credential", accountId: u.id, userId: u.id, password: hashed },
    });
    return u;
  });
  await audit(me, "user.create", "user", row.id, { role: body.role });
  res.status(201).json(row);
});

// GET /api/v1/admin/users/:id — full profile + session count + recent audit.
adminUsers.get("/:id", async (req, res) => {
  const row = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, username: true, name: true, email: true, role: true, isActive: true,
      canChangePassword: true, departmentId: true, academicYear: true, college: true, createdAt: true, updatedAt: true,
      department: { select: { id: true, code: true, name: true } },
      _count: { select: { sessions: true, studentExams: true, permissionOverrides: true } },
    },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  const recentAudit = await prisma.auditLog.findMany({
    where: { OR: [{ actorId: row.id }, { entityType: "user", entityId: row.id }] },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true, actorId: true },
  });
  res.json({ ...row, recentAudit });
});

// GET /api/v1/admin/users/:id/assignments — everything that binds this user
// to the academic structure in one call (department, doctor subjects, TA
// sections, student enrollments + section seats). Read-only.
adminUsers.get("/:id/assignments", async (req, res) => {
  const row = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, role: true,
      department: { select: { id: true, code: true, name: true } },
      doctorAssignments: { select: { subjectId: true, termId: true, subject: { select: { code: true, name: true } }, term: { select: { name: true, isCurrent: true } } } },
      taughtSections: { select: { id: true, name: true, subjectId: true, termId: true, subject: { select: { code: true } }, term: { select: { name: true } } } },
      enrollments: { select: { subjectId: true, termId: true, subject: { select: { code: true, name: true } }, term: { select: { name: true } } } },
      sectionMemberships: { select: { section: { select: { id: true, name: true, subject: { select: { code: true } }, term: { select: { name: true } } } } } },
    },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// POST /api/v1/admin/users/:id/department {departmentId|null} — move a user
// between departments. Peer admins are immutable here too.
adminUsers.post("/:id/department", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const { departmentId } = z.object({ departmentId: z.string().uuid().nullable() }).parse(req.body);
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, target as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  if (departmentId) {
    const dept = await prisma.department.count({ where: { id: departmentId } });
    if (!dept) return res.status(400).json({ error: "invalid reference", field: "departmentId" });
  }
  const row = await prisma.user.update({ where: { id: target.id }, data: { departmentId } });
  await audit(me, "user.department", "user", row.id, { departmentId });
  res.json(row);
});

// GET /api/v1/admin/users/:id/sessions — active login sessions for realtime revoke UI.
adminUsers.get("/:id/sessions", async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  const sessions = await prisma.session.findMany({
    where: { userId: target.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, expiresAt: true, ipAddress: true, userAgent: true, createdAt: true, updatedAt: true },
  });
  res.json(sessions);
});

// DELETE /api/v1/admin/users/:id/sessions — revoke all sessions (immediate logout everywhere).
adminUsers.delete("/:id/sessions", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, target as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  const revoked = await prisma.session.deleteMany({ where: { userId: target.id } });
  await audit(me, "user.sessions-revoke", "user", target.id, { revoked: revoked.count });
  res.json({ ok: true, revoked: revoked.count });
});

// PATCH /api/v1/admin/users/:id — full profile management (name, email,
// username, role, flags, department, active). Peer-admin writes are 403;
// promoting anyone to admin is 403 (admins are seeded, not minted via API).
// Disabling revokes sessions immediately; every change is audit-logged.
adminUsers.patch("/:id", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
    role: z.enum(["doctor", "ta", "student"]).optional(),
    isActive: z.boolean().optional(),
    canChangePassword: z.boolean().optional(),
    academicYear: z.number().int().min(1).max(7).nullable().optional(),
    college: z.string().trim().max(120).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);
  const before = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, before as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  if (before.id === me && body.isActive === false) {
    return res.status(422).json({ error: "cannot disable your own admin account" });
  }
  // The role enum excludes "admin", so ANY self role change is a demotion —
  // block it like self-disable (self-inflicted loss of the admin plane).
  if (before.id === me && body.role && body.role !== (before.role as string)) {
    return res.status(422).json({ error: "cannot change your own role" });
  }
  if (body.departmentId) {
    const dept = await prisma.department.count({ where: { id: body.departmentId } });
    if (!dept) return res.status(400).json({ error: "invalid reference", field: "departmentId" });
  }
  const data: Record<string, unknown> = { ...body };
  if (typeof data["username"] === "string") data["username"] = (data["username"] as string).toLowerCase();
  if (typeof data["email"] === "string") data["email"] = (data["email"] as string).toLowerCase();
  if (data["college"] === "") data["college"] = null;
  const row = await prisma.user.update({ where: { id: before.id }, data: data as never });
  // Role change de-escalates fully: override rows win over role defaults, so
  // leaving them would let a demoted user keep elevated keys.
  let overridesCleared = 0;
  if (body.role && body.role !== (before.role as string)) {
    const cleared = await prisma.userPermissionOverride.deleteMany({ where: { userId: before.id } });
    overridesCleared = cleared.count;
  }
  // Realtime enforcement: a disable must kill live sessions now, not on expiry.
  let sessionsRevoked = 0;
  if (body.isActive === false && before.isActive !== false) {
    const revoked = await prisma.session.deleteMany({ where: { userId: row.id } });
    sessionsRevoked = revoked.count;
  }
  const action = body.isActive === false && before.isActive !== false
    ? "user.disable"
    : body.isActive === true && before.isActive === false
      ? "user.enable"
      : "user.update";
  await audit(me, action, "user", row.id, { before: { name: before.name, email: before.email, username: before.username, role: before.role, isActive: before.isActive, canChangePassword: before.canChangePassword, academicYear: before.academicYear, college: before.college, departmentId: before.departmentId }, after: body, sessionsRevoked, overridesCleared });
  res.json({ ...row, sessionsRevoked });
});

// POST /api/v1/admin/users/:id/reset-password — the ONLY way a student gets a new pw.
adminUsers.post("/:id/reset-password", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const { password } = z.object({ password: z.string().min(config.password.minLength) }).parse(req.body);
  const { hashPassword } = await import("better-auth/crypto");
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, isActive: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, target as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  const hashed = await hashPassword(password);
  await prisma.account.upsert({
    where: { providerId_accountId: { providerId: "credential", accountId: target.id } },
    update: { password: hashed },
    create: { id: `acc-${target.id}`, providerId: "credential", accountId: target.id, userId: target.id, password: hashed },
  });
  // A reset must lock the account out everywhere: kill live sessions (up to
  // SESSION_HOURS old) so the old password cannot linger.
  const revoked = await prisma.session.deleteMany({ where: { userId: target.id } });
  await audit(me, "user.reset-password", "user", target.id, { sessionsRevoked: revoked.count });
  res.json({ ok: true, sessionsRevoked: revoked.count });
});
