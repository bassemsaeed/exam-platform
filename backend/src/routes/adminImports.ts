import { Router, type Router as RouterType } from "express";
import { hashPassword } from "better-auth/crypto";
import multer from "multer";
import * as XLSX from "xlsx";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { defaultCanChangePassword, isValidRole, type Role } from "../lib/domain.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

// Excel columns: username*, password*, full_name*, role(admin|doctor|ta|student)*,
// email?, year? (1..7 student cohort), college? (free text),
// subjects (student: "CS301,CS302"), taught (doctor: "CS301"),
// sections (TA: "CS301:A,B;CS302:C"). Passwords stay in memory only — hashed
// with better-auth/crypto (same verifier as login) before any DB write, and the
// batch payload is wiped on commit. Raw file is never persisted.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadMaxBytes } });

interface ParsedRow {
  line: number;
  username: string;
  password: string;
  fullName: string;
  role: Role;
  email?: string;
  academicYear?: number;
  college?: string;
  subjects: string[];
  taught: string[];
  sections: { code: string; names: string[] }[];
}

function parseWorkbook(buf: Buffer): { rows: ParsedRow[]; errors: { line: number; reason: string }[] } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const rows: ParsedRow[] = [];
  const errors: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  const str = (v: unknown) => String(v ?? "").trim();
  raw.forEach((r, i) => {
    const line = i + 2;
    const username = str(r.username).toLowerCase();
    const password = str(r.password);
    const fullName = str(r.full_name);
    const role = str(r.role).toLowerCase();
    if (!username || !password || !fullName || !role) return errors.push({ line, reason: "missing username|password|full_name|role" });
    if (!isValidRole(role)) return errors.push({ line, reason: `bad role ${role}` });
    // Admins are seeded, never minted via Excel: blocks privilege escalation
    // through a borrowed admin session + a crafted roster file.
    if (role === "admin") return errors.push({ line, reason: "admin role cannot be imported (seeded only)" });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return errors.push({ line, reason: `bad username chars: ${username}` });
    if (password.length < config.password.minLength) return errors.push({ line, reason: `password < ${config.password.minLength} chars` });
    if (seen.has(username)) return errors.push({ line, reason: `duplicate username in file: ${username}` });
    seen.add(username);
    // Optional cohort columns: year (1..7 int), college (free text ≤120).
    let academicYear: number | undefined;
    const yearRaw = str(r.year);
    if (yearRaw) {
      const y = Number(yearRaw);
      if (!Number.isInteger(y) || y < 1 || y > 7) return errors.push({ line, reason: `bad year (want 1..7): ${yearRaw}` });
      academicYear = y;
    }
    const collegeRaw = str(r.college);
    if (collegeRaw.length > 120) return errors.push({ line, reason: "college longer than 120 chars" });
    const college = collegeRaw || undefined;
    const sections: ParsedRow["sections"] = [];
    for (const part of str(r.sections).split(";").map((s) => s.trim()).filter(Boolean)) {
      const [code, names] = part.split(":").map((s) => s.trim());
      if (!code || !names) return errors.push({ line, reason: `bad sections format: ${part}` });
      sections.push({ code, names: names.split(",").map((s) => s.trim()).filter(Boolean) });
    }
    rows.push({
      line, username, password, fullName, role,
      email: str(r.email) || undefined,
      academicYear, college,
      subjects: str(r.subjects).split(",").map((s) => s.trim()).filter(Boolean),
      taught: str(r.taught).split(",").map((s) => s.trim()).filter(Boolean),
      sections,
    });
  });
  return { rows, errors };
}

export const adminImports: RouterType = Router();
adminImports.use(requireAuth, requireRole("admin"));

adminImports.post("/dry-run", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const me = (req as unknown as AuthedRequest).userId;
  const { rows, errors } = parseWorkbook(req.file.buffer);
  const codes = new Set([...rows.flatMap((r) => [...r.subjects, ...r.taught, ...r.sections.map((s) => s.code)])]);
  const existing = await prisma.subject.findMany({ where: { code: { in: [...codes] } }, select: { code: true } });
  const known = new Set(existing.map((s) => s.code));
  const final = errors.slice();
  const valid = rows.filter((r) => {
    const bad = [...r.subjects, ...r.taught, ...r.sections.map((s) => s.code)].filter((c) => !known.has(c));
    if (bad.length) {
      final.push({ line: r.line, reason: `unknown subject codes: ${bad.join(",")}` });
      return false;
    }
    return true;
  });
  const batch = await (async () => {
    // Hash BEFORE persisting: import_batch.payload must never hold plaintext.
    // Stored rows carry passwordHash; commit consumes it directly (no re-hash).
    type SafeRow = Omit<ParsedRow, "password"> & { passwordHash: string };
    const safe: SafeRow[] = [];
    const n = config.importBatch.hashConcurrency;
    for (let i = 0; i < valid.length; i += n) {
      const chunk = await Promise.all(
        valid.slice(i, i + n).map(async (r) => {
          const { password, ...rest } = r;
          return { ...rest, passwordHash: await hashPassword(password) };
        }),
      );
      safe.push(...chunk);
    }
    return prisma.importBatch.create({
      data: {
        type: "users",
        uploadedBy: me,
        filename: req.file!.originalname,
        status: "dry_run",
        totalRows: rows.length + errors.length,
        validRows: valid.length,
        payload: JSON.parse(JSON.stringify(safe)),
        expiresAt: new Date(Date.now() + config.importBatch.ttlMs),
      },
    });
  })();
  res.json({ batchId: batch.id, valid: valid.length, errors: final, expiresAt: batch.expiresAt });
});

adminImports.post("/commit", async (req, res) => {
  const { batchId } = z.object({ batchId: z.string() }).parse(req.body);
  const me = (req as unknown as AuthedRequest).userId;
  // Term BEFORE claim: a stuck batch must never sit `committed` with its
  // password-hash payload retained and unretryable.
  const term = await prisma.term.findFirst({ where: { isCurrent: true } });
  if (!term) return res.status(409).json({ error: "no current term" });
  // Atomic claim: only one committer can flip dry_run→committed (kills the
  // double-commit race). A second caller sees count 0 and gets told why.
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, type: "users", status: "dry_run", expiresAt: { gt: new Date() } },
    data: { status: "committed" },
  });
  if (claimed.count === 0) {
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { status: true, expiresAt: true, type: true } });
    if (!batch || batch.type !== "users") return res.status(404).json({ error: "batch not found" });
    if (batch.expiresAt.getTime() < Date.now()) {
      await prisma.importBatch.update({ where: { id: batchId }, data: { status: "expired", payload: {} } });
      return res.status(409).json({ error: "batch expired" });
    }
    return res.status(409).json({ error: `already ${batch.status}` });
  }
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  type StoredRow = Omit<ParsedRow, "password"> & { passwordHash: string };
  const rows = batch.payload as unknown as StoredRow[];

  let imported = 0;
  const rowErrors: { line: number; reason: string }[] = [];
  for (const r of rows) {
    if ((r.role as string) === "admin") {
      rowErrors.push({ line: r.line, reason: "admin role cannot be imported (seeded only)" });
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const email = r.email || `${r.username}@${config.email.placeholderDomain}`;
        // Cohort columns only overwrite when present in the file — a re-import
        // without year/college must not wipe values set elsewhere.
        const cohort = {
          ...(r.academicYear !== undefined ? { academicYear: r.academicYear } : {}),
          ...(r.college !== undefined ? { college: r.college } : {}),
        };
        // Re-imports must not resurrect disabled accounts or clobber a real
        // email with a blank-cell placeholder: presence semantics — absent in
        // the file means "don't touch", exactly like year/college above.
        const existing = await tx.user.findUnique({
          where: { username: r.username },
          select: { id: true, role: true, email: true, isActive: true },
        });
        const targetEmail = r.email ? r.email.toLowerCase() : (existing?.email ?? email.toLowerCase());
        const user = existing
          ? await tx.user.update({
              where: { id: existing.id },
              data: { name: r.fullName, email: targetEmail, role: r.role, canChangePassword: defaultCanChangePassword(r.role), ...cohort },
            })
          : await tx.user.create({
              data: { id: `u_${r.username}`, name: r.fullName, email: email.toLowerCase(), emailVerified: false, username: r.username, role: r.role, canChangePassword: defaultCanChangePassword(r.role), isActive: true, academicYear: r.academicYear ?? null, college: r.college ?? null },
            });
        // Role changes de-escalate fully here too (overrides win over role
        // defaults — see PATCH /admin/users/:id).
        if (existing && existing.role !== r.role) {
          await tx.userPermissionOverride.deleteMany({ where: { userId: existing.id } });
        }
        await tx.account.upsert({
          where: { providerId_accountId: { providerId: "credential", accountId: user.id } },
          update: { password: r.passwordHash },
          create: { id: `acc-${user.id}`, providerId: "credential", accountId: user.id, userId: user.id, password: r.passwordHash },
        });
        if (r.role === "student") {
          await tx.enrollment.deleteMany({ where: { studentId: user.id, termId: term.id } });
          if (r.subjects.length) {
            const subs = await tx.subject.findMany({ where: { code: { in: r.subjects } }, select: { id: true } });
            await tx.enrollment.createMany({ data: subs.map((s) => ({ studentId: user.id, subjectId: s.id, termId: term.id })) });
          }
        } else if (r.role === "doctor") {
          await tx.doctorAssignment.deleteMany({ where: { doctorId: user.id, termId: term.id } });
          if (r.taught.length) {
            const subs = await tx.subject.findMany({ where: { code: { in: r.taught } }, select: { id: true } });
            await tx.doctorAssignment.createMany({ data: subs.map((s) => ({ doctorId: user.id, subjectId: s.id, termId: term.id })) });
          }
        } else if (r.role === "ta") {
          for (const s of r.sections) {
            const sub = await tx.subject.findUnique({ where: { code: s.code }, select: { id: true } });
            if (!sub) continue;
            for (const name of s.names) {
              const sec = await tx.section.findUnique({
                where: { subjectId_termId_name: { subjectId: sub.id, termId: term.id, name } },
                select: { id: true, taId: true },
              });
              if (!sec) {
                await tx.section.create({ data: { subjectId: sub.id, termId: term.id, taId: user.id, name } });
              } else if (sec.taId !== user.id) {
                // Never silently steal another TA's section via import (last-
                // writer-wins on crafted/stale rosters): reassignment stays an
                // explicit admin action. The section keeps its current TA.
                rowErrors.push({ line: r.line, reason: `section ${s.code}:${name} kept with its current TA` });
              }
            }
          }
        }
      });
      imported++;
    } catch (e) {
      rowErrors.push({ line: r.line, reason: e instanceof Error ? e.message : "failed" });
    }
  }

  // Post-claim bookkeeping is retry-relevant too: if the wipe/log write fails,
  // reopen the batch instead of leaving it committed. Row upserts above are
  // idempotent by username, so a retry replays safely.
  let logId: string;
  try {
    await prisma.importBatch.update({ where: { id: batch.id }, data: { payload: {} } }); // wipe hashes post-commit
    const log = await prisma.excelImportLog.create({
      data: { importType: "users", batchId: batch.id, uploadedBy: me, filename: batch.filename, totalRows: batch.totalRows, importedCount: imported, errorCount: rowErrors.length, errorReport: rowErrors },
    });
    await audit(me, "import.commit", "import_batch", batch.id, { imported, errors: rowErrors.length });
    logId = log.id;
  } catch {
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "dry_run" } }).catch(() => undefined);
    return res.status(500).json({ error: "commit bookkeeping failed, batch reopened for retry", imported, errors: rowErrors });
  }
  res.json({ ok: true, imported, errors: rowErrors, logId });
});

adminImports.get("/", async (req, res) => {
  const q = pageQuery.parse(req.query);
  const [total, rows] = await Promise.all([
    prisma.excelImportLog.count(),
    prisma.excelImportLog.findMany({ orderBy: { createdAt: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows));
});
