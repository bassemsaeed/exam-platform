import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { isPeerAdmin, isPermissionKey, PERMISSION_KEYS } from "../lib/domain.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminPermissions: RouterType = Router();
adminPermissions.use(requireAuth, requireRole("admin"));

// Fixed seeded matrix.
adminPermissions.get("/defaults", async (_req, res) => {
  res.json(await prisma.permissionDefault.findMany({ orderBy: [{ role: "asc" }, { permissionKey: "asc" }] }));
});

// Effective set for a user: defaults overlaid with overrides.
adminPermissions.get("/user/:id", async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  const [defs, overs] = await Promise.all([
    prisma.permissionDefault.findMany({ where: { role: target.role } }),
    prisma.userPermissionOverride.findMany({ where: { userId: target.id } }),
  ]);
  const over = new Map(overs.map((o) => [o.permissionKey, o.allowed]));
  // Iterate the fixed list — not role defaults — so overrides granting keys
  // outside your defaults still appear (previously invisible).
  res.json({
    userId: target.id,
    role: target.role,
    effective: PERMISSION_KEYS.map((key) => ({
      key,
      allowed: over.get(key) ?? defs.find((d) => d.permissionKey === key)?.allowed ?? false,
      overridden: over.has(key),
    })),
  });
});

adminPermissions.patch("/user/:id", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  const body = z.object({ key: z.string().min(2), allowed: z.boolean() }).parse(req.body);
  // Fixed list — Admin cannot invent keys (spec §2.3).
  if (!isPermissionKey(body.key)) return res.status(422).json({ error: "unknown permission key" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, target as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  const row = await prisma.userPermissionOverride.upsert({
    where: { userId_permissionKey: { userId: target.id, permissionKey: body.key } },
    update: { allowed: body.allowed },
    create: { userId: target.id, permissionKey: body.key, allowed: body.allowed },
  });
  await audit(me, "permission.override", "user", target.id, body);
  res.json(row);
});

adminPermissions.delete("/user/:id/:key", async (req, res) => {
  const me = (req as unknown as AuthedRequest).userId;
  // Same fixed-list validation as PATCH: unknown keys 422, missing users 404
  // (previously it deleted orphan rows and audited ghosts).
  if (!isPermissionKey(req.params.key)) return res.status(422).json({ error: "unknown permission key" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "not found" });
  if (isPeerAdmin(me, target as never)) return res.status(403).json({ error: "admins cannot modify other admins" });
  await prisma.userPermissionOverride.delete({ where: { userId_permissionKey: { userId: req.params.id, permissionKey: req.params.key } } });
  await audit(me, "permission.reset", "user", req.params.id, { key: req.params.key });
  res.json({ ok: true });
});
