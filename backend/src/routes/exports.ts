import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { isLocalStorage, localUploadsDir } from "../lib/storage.js";
import { buildExportFile, exportFormatOf } from "../lib/worker.js";
import { hasPermission, requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const exportsJobs: RouterType = Router();
exportsJobs.use(requireAuth);

// POST /exports {scope, exam_id?, subject_id?, term_id?, section_ids?}.
// Doctors see assigned subjects / own exams, TAs own exams + own sections,
// admins everything. Students are never exporters.
exportsJobs.post("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const body = z
    .object({
      scope: z.enum(["exam", "quiz", "all"]),
      examId: z.string().optional(),
      subjectId: z.string().optional(),
      termId: z.string().optional(),
      sectionIds: z.array(z.string()).max(config.lists.membersMax).optional(),
      format: z.enum(["csv", "xlsx"]).default("csv"),
    })
    .parse(req.body);

  let examId: string | undefined;
  let subjectId = body.subjectId;
  let termId = body.termId;
  let sectionIds = body.sectionIds ?? [];

  if (body.scope === "exam" || body.scope === "quiz") {
    if (!body.examId) return res.status(422).json({ error: "examId required for exam|quiz scope" });
    const exam = await prisma.exam.findUnique({ where: { id: body.examId } });
    if (!exam) return res.status(404).json({ error: "exam not found" });
    if (a.role === "doctor") {
      const ok =
        exam.createdBy === a.userId ||
        (await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: exam.subjectId, termId: exam.termId } }));
      if (!ok) return res.status(403).json({ error: "not your exam" });
      if (exam.createdBy !== a.userId && !(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "forbidden", need: "view_all_grades" });
      }
    } else if (a.role === "ta") {
      if (exam.createdBy !== a.userId) return res.status(403).json({ error: "not your quiz" });
      if (!(await hasPermission(a.userId, a.role, "view_own_grades"))) {
        return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
      }
    }
    examId = exam.id;
    subjectId = exam.subjectId;
    termId = exam.termId;
    if (sectionIds.length) {
      const valid = await prisma.section.count({ where: { id: { in: sectionIds }, subjectId, termId } });
      if (valid !== sectionIds.length) return res.status(422).json({ error: "sectionIds must belong to this subject+term" });
      if (a.role === "ta") {
        const own = await prisma.section.count({ where: { id: { in: sectionIds }, taId: a.userId } });
        if (own !== sectionIds.length) return res.status(403).json({ error: "not your sections" });
      }
    } else if (a.role === "ta") {
      // Default a TA export to their own sections of this exam's subject+term.
      sectionIds = (await prisma.section.findMany({ where: { taId: a.userId, subjectId, termId }, select: { id: true } })).map((s) => s.id);
    }
  } else {
    if (!termId) return res.status(422).json({ error: "termId required for all scope" });
    if (a.role === "doctor") {
      if (!subjectId) return res.status(422).json({ error: "subjectId required for all scope" });
      if (!(await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId, termId } }))) {
        return res.status(403).json({ error: "not assigned to subject for this term" });
      }
      if (!(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "forbidden", need: "view_all_grades" });
      }
    } else if (a.role === "ta") {
      if (!subjectId) return res.status(422).json({ error: "subjectId required for all scope" });
      if (!(await hasPermission(a.userId, a.role, "view_own_grades"))) {
        return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
      }
      const ownSecs = await prisma.section.findMany({ where: { taId: a.userId, subjectId, termId }, select: { id: true } });
      if (!ownSecs.length) return res.status(403).json({ error: "no sections here" });
      if (sectionIds.length) {
        const own = new Set(ownSecs.map((s) => s.id));
        if (!sectionIds.every((id) => own.has(id))) return res.status(403).json({ error: "not your sections" });
      } else {
        sectionIds = ownSecs.map((s) => s.id);
      }
    }
  }

  const row = await prisma.exportJob.create({
    data: {
      requestedBy: a.userId,
      examId: examId ?? null,
      subjectId: subjectId ?? null,
      scope: body.scope,
      params: { termId, subjectId, sectionIds, format: body.format },
      status: "queued",
    },
  });
  await audit(a.userId, "export.create", "export_job", row.id, { scope: body.scope, examId });
  res.status(201).json(row);
});

// GET /exports — my jobs (admin monitor lives under /admin/exports).
exportsJobs.get("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const q = pageQuery.parse(req.query);
  const where = { requestedBy: a.userId };
  const [total, rows] = await Promise.all([
    prisma.exportJob.count({ where }),
    prisma.exportJob.findMany({ where, orderBy: { createdAt: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows));
});

exportsJobs.get("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const row = await prisma.exportJob.findUnique({ where: { id: String(req.params.id) } });
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.requestedBy !== a.userId && a.role !== "admin") return res.status(403).json({ error: "not yours" });
  res.json(row);
});

// GET /exports/:id/download — finished file, capped sync fallback (?sync=1),
// or 409 while the worker is still on it.
exportsJobs.get("/:id/download", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const row = await prisma.exportJob.findUnique({ where: { id: String(req.params.id) } });
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.requestedBy !== a.userId && a.role !== "admin") return res.status(403).json({ error: "not yours" });

  const ext = exportFormatOf(row) === "xlsx" ? "xlsx" : "csv";
  const mime = ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8";
  const sendFile = (buf: Buffer | string) => {
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="export-${row.id}.${ext}"`);
    res.send(buf);
  };

  if (row.status === "done") {
    if (!isLocalStorage()) {
      if (!row.fileUrl) return res.status(404).json({ error: "file missing" });
      // S3 serves outside this response: log intent before redirect since
      // there is no finish event for the external fetch.
      await audit(a.userId, "export.download", "export_job", row.id, { format: ext });
      return res.redirect(row.fileUrl);
    }
    const key = ((row.params ?? {}) as { fileKey?: string }).fileKey;
    if (!key || !/^[A-Za-z0-9/_.-]+$/.test(key)) return res.status(404).json({ error: "file missing" });
    const abs = resolve(join(localUploadsDir(), key));
    if (!abs.startsWith(resolve(localUploadsDir()))) return res.status(400).json({ error: "bad file key" });
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="export-${row.id}.${ext}"`);
    // Audit only after the local stream actually finishes: a missing file or
    // aborted download must not log a download that never happened.
    res.on("finish", () => {
      audit(a.userId, "export.download", "export_job", row.id, { format: ext }).catch(() => undefined);
    });
    return createReadStream(abs)
      .on("error", () => {
        if (!res.headersSent) res.status(404).json({ error: "file missing" });
        else res.end();
      })
      .pipe(res);
  }

  if (req.query.sync === "1") {
    // Bounded build: count-then-build races (rows added in between exceed the
    // cap), so the cap is enforced DURING the build instead.
    const { buffer, rows, truncated } = await buildExportFile(row, config.exportJob.syncMaxRows + 1);
    if (truncated || rows > config.exportJob.syncMaxRows) {
      return res.status(413).json({ error: "too large for sync, wait for worker", rows });
    }
    await audit(a.userId, "export.download-sync", "export_job", row.id, { rows });
    return sendFile(buffer);
  }
  return res.status(409).json({ error: "not ready, retry shortly" });
});
