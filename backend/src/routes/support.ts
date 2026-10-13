import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import {
  requireAuth,
  requireRole,
  type AuthedRequest,
} from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
export const support: RouterType = Router();
support.post(
  "/requests",
  rateLimit(5, 15 * 60_000, "account-support"),
  async (req, res) => {
    const body = z
      .object({
        kind: z.enum(["access", "password"]),
        name: z.string().trim().min(2).max(200),
        username: z.string().trim().max(100).optional(),
        contact: z.string().trim().email().max(320),
        details: z.string().trim().min(5).max(1500),
      })
      .parse(req.body);
    // Identical response for known and unknown users; never look up an account here.
    const row = await prisma.accountSupportRequest.create({
      data: { ...body, username: body.username?.toLowerCase() || null },
    });
    res.status(202).json({ reference: row.id.slice(0, 8).toUpperCase() });
  },
);
export const adminSupport: RouterType = Router();
adminSupport.use(requireAuth, requireRole("admin"));
adminSupport.get("/", async (req, res) => {
  const q = pageQuery
    .extend({ status: z.enum(["pending", "resolved", "closed"]).optional() })
    .parse(req.query);
  const where = q.status ? { status: q.status } : {};
  const [total, rows] = await Promise.all([
    prisma.accountSupportRequest.count({ where }),
    prisma.accountSupportRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...page(q),
    }),
  ]);
  res.json(envelope(total, q, rows));
});
adminSupport.patch("/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z
    .object({
      status: z.enum(["pending", "resolved", "closed"]),
      adminNote: z.string().trim().max(1500).optional(),
    })
    .parse(req.body);
  const row = await prisma.$transaction(async (tx) => {
    const row = await tx.accountSupportRequest.update({
      where: { id },
      data: {
        ...body,
        resolvedAt: body.status === "pending" ? null : new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: (req as unknown as AuthedRequest).userId,
        action: "support." + body.status,
        entityType: "account_support_request",
        entityId: id,
      },
    });
    return row;
  });
  res.json(row);
});
