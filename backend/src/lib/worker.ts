import { config } from "./config.js";
import { prisma } from "./prisma.js";
import { audit } from "./audit.js";
import { isLocalStorage, localUploadsDir, storage } from "./storage.js";
import { autoSubmitExam } from "../routes/student.js";
import type { ExportJob } from "../generated/prisma/client.js";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";

export type ExportFormat = "csv" | "xlsx";

// Background worker (single-server MVP): export jobs + expiry sweeper.
// Multi-server needs a distributed lock / queue — same function interface.

// --- CSV safety: neutralize spreadsheet formula injection (CWE-1236). ---
// Names/emails come from Excel imports; a leading =,+,-,@ (or tab/CR) would
// execute as a formula/DDE in the grader's Excel. Prefix with a quote.
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

const HEADER = ["exam_id", "username", "name", "sections", "status", "total_grade", "submitted_at"];

interface CsvSpec {
  examIds: string[];
  studentIds: string[] | null; // section filter (null = no filter)
  secMaps: Map<string, string[]>; // studentId -> section names
}

// Scoped exports must not label rows with out-of-scope section names: a TA
// exporting their own sections would otherwise learn other TAs' section
// names through students sitting in several sections.
async function scopeSectionMaps(secMaps: Map<string, string[]>, sectionIds: string[]): Promise<void> {
  const secs = await prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { name: true } });
  const allowed = new Set(secs.map((s) => s.name));
  for (const [k, v] of secMaps) secMaps.set(k, v.filter((n) => allowed.has(n)));
}

async function sectionMap(subjectId: string, termId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const rows = await prisma.sectionMembership.findMany({
    where: { section: { subjectId, termId } },
    select: { studentId: true, section: { select: { name: true } } },
  });
  for (const r of rows) {
    const list = out.get(r.studentId) ?? [];
    list.push(r.section.name);
    out.set(r.studentId, list);
  }
  return out;
}

async function resolveSpec(job: ExportJob): Promise<CsvSpec> {
  const params = (job.params ?? {}) as { sectionIds?: string[]; termId?: string; subjectId?: string };
  if ((job.scope === "exam" || job.scope === "quiz") && job.examId) {
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: job.examId } });
    let studentIds: string[] | null = null;
    if (params.sectionIds?.length) {
      const mem = await prisma.sectionMembership.findMany({
        where: { sectionId: { in: params.sectionIds } },
        select: { studentId: true },
      });
      studentIds = [...new Set(mem.map((m) => m.studentId))];
    }
    const secMaps = await sectionMap(exam.subjectId, exam.termId);
    if (params.sectionIds?.length) await scopeSectionMaps(secMaps, params.sectionIds);
    return { examIds: [exam.id], studentIds, secMaps };
  }
  // scope "all": every exam in the term (+subject filter), sections merged.
  if (!params.termId) throw new Error("all-scope export needs termId");
  const exams = await prisma.exam.findMany({
    where: { termId: params.termId, ...(params.subjectId ? { subjectId: params.subjectId } : {}) },
    select: { id: true, subjectId: true, termId: true },
  });
  let studentIds: string[] | null = null;
  if (params.sectionIds?.length) {
    const mem = await prisma.sectionMembership.findMany({
      where: { sectionId: { in: params.sectionIds } },
      select: { studentId: true },
    });
    studentIds = [...new Set(mem.map((m) => m.studentId))];
  }
  const secMaps = new Map<string, string[]>();
  const secCache = new Map<string, Map<string, string[]>>();
  for (const e of exams) {
    // One membership query per subject, not per exam.
    const cacheKey = `${e.subjectId}:${e.termId}`;
    let sm = secCache.get(cacheKey);
    if (!sm) {
      sm = await sectionMap(e.subjectId, e.termId);
      secCache.set(cacheKey, sm);
    }
    for (const [k, v] of sm) {
      secMaps.set(k, [...new Set([...(secMaps.get(k) ?? []), ...v])]);
    }
  }
  if (params.sectionIds?.length) await scopeSectionMaps(secMaps, params.sectionIds);
  return { examIds: exams.map((e) => e.id), studentIds, secMaps };
}

export async function countExportRows(job: ExportJob): Promise<number> {
  const spec = await resolveSpec(job);
  if (!spec.examIds.length) return 0;
  return prisma.studentExam.count({
    where: { examId: { in: spec.examIds }, ...(spec.studentIds ? { studentId: { in: spec.studentIds } } : {}) },
  });
}

// Cursor pagination (never loads 5k rows into RAM): stable id order, one page
// at a time, shared by the async worker and the capped sync fallback.
// Values are formula-neutralized for spreadsheets; quoting is CSV-only.
// maxRows bounds the build itself (count-then-build would race): overflow is
// reported via `truncated` instead of silently exceeding the caller's cap.
async function collectExportRows(job: ExportJob, maxRows = Number.POSITIVE_INFINITY): Promise<{ header: string[]; rows: string[][]; truncated: boolean }> {
  const spec = await resolveSpec(job);
  const rows: string[][] = [];
  if (!spec.examIds.length) return { header: HEADER, rows, truncated: false };
  const pageSize = config.exportJob.pageSize;
  let cursor: string | undefined;
  for (;;) {
    const remaining = maxRows - rows.length + 1; // +1 to detect overflow
    if (remaining <= 0) return { header: HEADER, rows: rows.slice(0, maxRows), truncated: true };
    const page = await prisma.studentExam.findMany({
      where: { examId: { in: spec.examIds }, ...(spec.studentIds ? { studentId: { in: spec.studentIds } } : {}) },
      include: { student: { select: { username: true, name: true } } },
      orderBy: { id: "asc" },
      take: Math.min(pageSize, Math.ceil(remaining)),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    for (const r of page) {
      rows.push(
        [
          r.examId,
          r.student.username ?? "",
          r.student.name,
          (spec.secMaps.get(r.studentId) ?? []).join(";"),
          r.status,
          r.totalGrade?.toString() ?? "",
          r.submittedAt?.toISOString() ?? "",
        ].map((v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)),
      );
      if (rows.length > maxRows) return { header: HEADER, rows: rows.slice(0, maxRows), truncated: true };
    }
    cursor = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }
  return { header: HEADER, rows, truncated: false };
}

// Streaming row iterator for the async worker: yields one neutralized row at
// a time while paging cursors, so a term-wide 25k-row export never holds the
// full string matrix on the heap (D-05). The capped sync fallback keeps using
// collectExportRows (≤2k rows by config).
async function* iterateExportRows(job: ExportJob): AsyncGenerator<string[], void, void> {
  const spec = await resolveSpec(job);
  if (!spec.examIds.length) return;
  const pageSize = config.exportJob.pageSize;
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.studentExam.findMany({
      where: { examId: { in: spec.examIds }, ...(spec.studentIds ? { studentId: { in: spec.studentIds } } : {}) },
      include: { student: { select: { username: true, name: true } } },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    for (const r of page) {
      yield [
        r.examId,
        r.student.username ?? "",
        r.student.name,
        (spec.secMaps.get(r.studentId) ?? []).join(";"),
        r.status,
        r.totalGrade?.toString() ?? "",
        r.submittedAt?.toISOString() ?? "",
      ].map((v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v));
    }
    cursor = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }
}

// Streaming CSV build to a temp file (one line at a time, O(pageSize) RAM).
// Returns the temp path + row count; caller moves/uploads then unlinks.
async function buildCsvToTempFile(job: ExportJob): Promise<{ tmpPath: string; rows: number }> {
  const tmpPath = join(tmpdir(), `export-${job.id}-${randomUUID()}.csv`);
  const out = createWriteStream(tmpPath, { encoding: "utf8" });
  out.write(`${HEADER.map(csvCell).join(",")}\n`);
  let rows = 0;
  for await (const row of iterateExportRows(job)) {
    const ok = out.write(`${row.map(csvCell).join(",")}\n`);
    rows++;
    if (!ok) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  return { tmpPath, rows };
}

export function exportFormatOf(job: ExportJob): ExportFormat {
  const f = ((job.params ?? {}) as { format?: string }).format;
  return f === "xlsx" ? "xlsx" : "csv";
}

export async function buildExportCsv(job: ExportJob, maxRows = Number.POSITIVE_INFINITY): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const { header, rows, truncated } = await collectExportRows(job, maxRows);
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return { csv: `${lines.join("\n")}\n`, rows: rows.length, truncated };
}

export async function buildExportFile(job: ExportJob, maxRows = Number.POSITIVE_INFINITY): Promise<{ buffer: Buffer; ext: string; mime: string; rows: number; truncated: boolean }> {
  if (exportFormatOf(job) === "xlsx") {
    const { header, rows, truncated } = await collectExportRows(job, maxRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), "grades");
    return { buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer), ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", rows: rows.length, truncated };
  }
  const { csv, rows, truncated } = await buildExportCsv(job, maxRows);
  return { buffer: Buffer.from(csv, "utf8"), ext: "csv", mime: "text/csv; charset=utf-8", rows, truncated };
}

async function processNextExportJob(): Promise<boolean> {
  const job = await prisma.exportJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!job) return false;
  // Atomic claim: with N app servers this still needs a lock (deferred), but
  // single-server it can never double-run.
  const claimed = await prisma.exportJob.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "running" } });
  if (!claimed.count) return true;
  try {
    const ext = exportFormatOf(job) === "xlsx" ? "xlsx" : "csv";
    if (ext === "csv") {
      // Streamed path: O(pageSize) heap regardless of term size.
      const { tmpPath, rows } = await buildCsvToTempFile(job);
      try {
        if (isLocalStorage()) {
          const key = `exports/export-${job.id}.csv`;
          const dest = join(localUploadsDir(), key);
          await mkdir(dirname(dest), { recursive: true });
          await rename(tmpPath, dest);
          await prisma.exportJob.update({
            where: { id: job.id },
            data: { status: "done", fileUrl: `/uploads/${key}`, params: { ...((job.params ?? {}) as object), fileKey: key, rows } },
          });
        } else {
          const { readFile } = await import("node:fs/promises");
          const buf = await readFile(tmpPath);
          const stored = await storage.put("exports", `export-${job.id}.csv`, buf);
          await prisma.exportJob.update({
            where: { id: job.id },
            data: { status: "done", fileUrl: stored.url, params: { ...((job.params ?? {}) as object), fileKey: stored.key, rows } },
          });
        }
        await audit(job.requestedBy, "export.done", "export_job", job.id, { rows });
      } finally {
        await rm(tmpPath, { force: true }).catch(() => undefined);
      }
    } else {
      const { buffer, rows } = await buildExportFile(job);
      const stored = await storage.put("exports", `export-${job.id}.${ext}`, Buffer.from(buffer));
      await prisma.exportJob.update({
        where: { id: job.id },
        data: { status: "done", fileUrl: stored.url, params: { ...((job.params ?? {}) as object), fileKey: stored.key, rows } },
      });
      await audit(job.requestedBy, "export.done", "export_job", job.id, { rows });
    }
  } catch (e) {
    await prisma.exportJob.update({ where: { id: job.id }, data: { status: "failed" } });
    await audit(job.requestedBy, "export.failed", "export_job", job.id, { error: e instanceof Error ? e.message : "failed" });
  }
  return true;
}

// Expiry sweeper: demand-driven auto-submit (request paths) leaves dropouts in
// `in_progress` with NULL grades. This tick finalizes them after the fact so
// results/exports are complete.
// Expiry is computed IN SQL (started_at + duration / exam end_time): fetching
// "oldest N, filter in Node" would let long unexpired exams permanently crowd
// out newer expired ones (head-of-line starvation).
async function sweepExpiredExams(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT se.id
    FROM student_exam se
    JOIN exam e ON e.id = se.exam_id
    WHERE se.status = 'in_progress'
      AND (
        e.end_time <= NOW()
        OR se.started_at + (e.duration_minutes || ' minutes')::interval <= NOW()
      )
    ORDER BY se.started_at ASC
    LIMIT ${config.sweep.batchMax}`;
  let done = 0;
  for (const r of rows) {
    // Per-row isolation: one corrupt instance must not stall the rest of the
    // tick (previously the first throw aborted the whole batch until next poll).
    try {
      await autoSubmitExam(r.id);
      done++;
    } catch (e) {
      console.error("expiry sweeper row failed", r.id, e);
    }
  }
  return done;
}

export function startBackgroundWorker(): void {
  setInterval(() => void (async () => {
    try {
      while (await processNextExportJob());
    } catch (e) {
      console.error("export worker tick failed", e);
    }
  })(), config.exportJob.pollMs).unref();
  setInterval(() => void (async () => {
    try {
      await sweepExpiredExams();
    } catch (e) {
      console.error("expiry sweeper tick failed", e);
    }
  })(), config.sweep.pollMs).unref();
}
