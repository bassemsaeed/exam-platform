import { Router, type Router as RouterType } from "express";
import { audit } from "../lib/audit.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminExports: RouterType = Router();
adminExports.use(requireAuth, requireRole("admin"));

// Export workers (doctor/TA scope) create ExportJob rows; admin monitors/retries.
adminExports.get("/", async (req, res) => {
  const q = pageQuery.parse(req.query);
  const [total, rows] = await Promise.all([
    prisma.exportJob.count(),
    prisma.exportJob.findMany({ orderBy: { createdAt: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows));
});

adminExports.post("/:id/retry", async (req, res) => {
  // Retry is for failed jobs only: resetting a done job would kill its
  // download link. The worker picks the requeued job up on its next tick.
  const cur = await prisma.exportJob.findUnique({ where: { id: req.params.id }, select: { status: true } });
  if (!cur) return res.status(404).json({ error: "not found" });
  if (cur.status !== "failed") return res.status(409).json({ error: "only failed jobs can be retried" });
  const row = await prisma.exportJob.update({ where: { id: req.params.id }, data: { status: "queued", fileUrl: null } });
  await audit((req as unknown as AuthedRequest).userId, "export.retry", "export_job", row.id, { from: cur.status });
  res.json(row);
});
