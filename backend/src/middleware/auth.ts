import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import type { Role } from "../generated/prisma/browser.js";
import { prisma } from "../lib/prisma.js";

export interface AuthedRequest extends Request {
  userId: string;
  role: Role;
}

// Session via Better Auth (cookie). Rejects inactive users and revokes any
// lingering sessions immediately so a disable takes effect in realtime.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session?.user) return res.status(401).json({ error: "unauthenticated" });
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true, isActive: true },
  });
  if (!me) return res.status(401).json({ error: "unauthenticated" });
  if (!me.isActive) {
    // Best-effort realtime kill: the disable route already deletes sessions,
    // but a direct DB flip or a race still lands here — wipe so get-session
    // goes null and the client drops to /login on its next poll.
    try {
      await prisma.session.deleteMany({ where: { userId: me.id } });
    } catch {
      // revocation must never mask the 403
    }
    return res.status(403).json({ error: "account disabled" });
  }
  const authed = req as unknown as AuthedRequest;
  authed.userId = me.id;
  authed.role = me.role;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = (req as unknown as AuthedRequest).role;
    if (!roles.includes(r)) return res.status(403).json({ error: "forbidden", need: roles });
    next();
  };
}

// Permission-key gate: admin is superuser (always passes); everyone else is
// checked against override-wins-then-default (spec §2.3). Wired into
// question-bank, exams create/results and student start/submit so overrides
// actually enforce — a display-only matrix would lie.
export function requirePermission(key: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const a = req as unknown as AuthedRequest;
    if (a.role === "admin") return next();
    if (!(await hasPermission(a.userId, a.role, key))) {
      return res.status(403).json({ error: "forbidden", need: key });
    }
    next();
  };
}

// Effective permission: override row wins, else role default.
export async function hasPermission(userId: string, role: Role, key: string): Promise<boolean> {
  const over = await prisma.userPermissionOverride.findUnique({
    where: { userId_permissionKey: { userId, permissionKey: key } },
  });
  if (over) return over.allowed;
  const def = await prisma.permissionDefault.findUnique({
    where: { role_permissionKey: { role: role as never, permissionKey: key } },
  });
  return def?.allowed ?? false;
}
