import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { config } from "../lib/config.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const adminAudit: RouterType = Router();
adminAudit.use(requireAuth, requireRole("admin"));

// GET /api/v1/admin/audit?actor&action&entity&entityType&page — append-only trail.
adminAudit.get("/", async (req, res) => {
  const q = pageQuery.extend({ actor: z.string().optional(), action: z.string().optional(), entity: z.string().optional(), entityType: z.string().optional() }).parse(req.query);
  const where = {
    ...(q.actor ? { actorId: q.actor } : {}),
    ...(q.action ? { action: { contains: q.action, mode: "insensitive" as const } } : {}),
    ...(q.entity ? { entityId: q.entity } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...page(q),
      include: { actor: { select: { id: true, username: true, name: true, role: true } } },
    }),
  ]);
  res.json(envelope(total, q, rows));
});

// GET /api/v1/admin/stats?term_id — live exam-room overview for 5k day.
adminAudit.get("/stats", async (req, res) => {
  const term = await (async () => {
    if (typeof req.query.term_id === "string") return { id: req.query.term_id };
    return prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
  })();
  if (!term) return res.status(409).json({ error: "no term" });
  const [users, live, started, submitted, stale] = await Promise.all([
    prisma.user.count({ where: { isActive: true } }),
    prisma.exam.count({ where: { termId: term.id, status: "approved", startTime: { lte: new Date() }, endTime: { gte: new Date() } } }),
    prisma.studentExam.count({ where: { exam: { termId: term.id }, status: "in_progress" } }),
    prisma.studentExam.count({ where: { exam: { termId: term.id }, status: { in: ["submitted", "auto_submitted"] } } }),
    prisma.studentExam.count({ where: { exam: { termId: term.id }, status: "in_progress", lastHeartbeatAt: { lt: new Date(Date.now() - config.heartbeat.staleMs) } } }),
  ]);
  res.json({ termId: term.id, users, liveExams: live, inProgress: started, submitted, staleHeartbeats: stale });
});
