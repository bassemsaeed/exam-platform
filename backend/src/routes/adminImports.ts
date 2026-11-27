import crypto from "node:crypto";
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
import { rateLimit } from "../middleware/rateLimit.js";
import {
  generateReadablePassword,
  parseStudentWorkbook,
  safeExcelCell,
  type StudentSheetRow,
} from "../lib/studentImportUtils.js";

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

function spreadsheetFileOk(filename: string, mimetype: string): boolean {
  const lower = filename.toLowerCase();
  if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv"))) return false;
  const mt = mimetype.toLowerCase();
  if (/spreadsheet|excel|csv|octet-stream/.test(mt)) return true;
  return false;
}

function parseWorkbook(buf: Buffer): { rows: ParsedRow[]; errors: { line: number; reason: string }[] } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch {
    throw new Error("empty or corrupt file");
  }
  const first = wb.SheetNames[0];
  if (!first || !wb.Sheets[first]) throw new Error("empty or corrupt file");
  const ws = wb.Sheets[first];
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

// College free text → entity link (case-insensitive by name or code). Unknown names resolve
// to nothing: the text is still stored, the link stays empty, and the caller
// reports the names so an admin can create/merge colleges afterwards.
async function resolveCollegeIds(texts: string[]): Promise<{ byText: Map<string, string>; unknown: string[] }> {
  const uniq = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  const byText = new Map<string, string>();
  const unknown: string[] = [];
  for (const text of uniq) {
    const row = await prisma.college.findFirst({
      where: {
        OR: [
          { name: { equals: text, mode: "insensitive" } },
          { code: { equals: text, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (row) byText.set(text.toLowerCase(), row.id);
    else unknown.push(text);
  }
  return { byText, unknown };
}

adminImports.post("/dry-run", rateLimit(30, 60_000, "admin-import:dry-run"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  if (!spreadsheetFileOk(req.file.originalname, req.file.mimetype)) {
    return res.status(422).json({ error: "file must be .xlsx/.xls/.csv" });
  }
  const me = (req as unknown as AuthedRequest).userId;
  let parsed: { rows: ParsedRow[]; errors: { line: number; reason: string }[] };
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch {
    return res.status(422).json({ error: "empty or corrupt file" });
  }
  const { rows, errors } = parsed;
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
  res.json({ batchId: batch.id, valid: valid.length, errors: final, expiresAt: batch.expiresAt, unknownColleges: (await resolveCollegeIds(valid.map((r) => r.college ?? ""))).unknown, preview: valid.slice(0, 50).map((r) => ({ line: r.line, username: r.username, fullName: r.fullName, role: r.role, email: r.email ?? null, subjects: r.subjects, taught: r.taught, sections: r.sections })), previewTruncated: valid.length > 50 });
});

adminImports.post("/commit", rateLimit(30, 60_000, "admin-import:commit"), async (req, res) => {
  const { batchId } = z.object({ batchId: z.string() }).parse(req.body);
  const me = (req as unknown as AuthedRequest).userId;
  // Term BEFORE claim: a stuck batch must never sit `committed` with its
  // password-hash payload retained and unretryable.
  const term = await prisma.term.findFirst({ where: { isCurrent: true } });
  if (!term) return res.status(409).json({ error: "no current term" });
  // Pre-verify ownership & payload kind so a target_students batch cannot be
  // committed through the legacy all-roles route (prevents type confusion).
  const pre = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { status: true, expiresAt: true, type: true, uploadedBy: true, payload: true },
  });
  if (!pre || pre.type !== "users") return res.status(404).json({ error: "batch not found" });
  if (pre.uploadedBy !== me) return res.status(403).json({ error: "only the uploader can commit this batch" });
  if (!Array.isArray(pre.payload)) {
    return res.status(400).json({ error: "wrong commit endpoint for this batch type" });
  }
  // Atomic claim: only one committer can flip dry_run→committed (kills the
  // double-commit race). A second caller sees count 0 and gets told why.
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, type: "users", uploadedBy: me, status: "dry_run", expiresAt: { gt: new Date() } },
    data: { status: "committed" },
  });
  if (claimed.count === 0) {
    if (pre.status === "dry_run" && pre.expiresAt.getTime() < Date.now()) {
      await prisma.importBatch.updateMany({
        where: { id: batchId, status: "dry_run" },
        data: { status: "expired", payload: {} },
      });
      return res.status(409).json({ error: "batch expired" });
    }
    return res.status(409).json({ error: `already ${pre.status}` });
  }
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  type StoredRow = Omit<ParsedRow, "password"> & { passwordHash: string };
  const rows = batch.payload as unknown as StoredRow[];
  const colleges = await resolveCollegeIds(rows.map((r) => r.college ?? ""));

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
        const collegeId = r.college ? (colleges.byText.get(r.college.trim().toLowerCase()) ?? null) : undefined;
        const cohort = {
          ...(r.academicYear !== undefined ? { academicYear: r.academicYear } : {}),
          ...(r.college !== undefined ? { college: r.college, collegeId } : {}),
        };
        // Re-imports must not resurrect disabled accounts or clobber a real
        // email with a blank-cell placeholder: presence semantics — absent in
        // the file means "don't touch", exactly like year/college above.
        const existing = await tx.user.findUnique({
          where: { username: r.username },
          select: { id: true, role: true, email: true, isActive: true },
        });
        if (existing && existing.role === "admin") {
          throw new Error("admin accounts cannot be modified via import");
        }
        const targetEmail = r.email ? r.email.toLowerCase() : (existing?.email ?? email.toLowerCase());
        const user = existing
          ? await tx.user.update({
              where: { id: existing.id },
              data: { name: r.fullName, email: targetEmail, role: r.role, canChangePassword: defaultCanChangePassword(r.role), ...cohort },
            })
          : await tx.user.create({
              data: { id: `u_${crypto.randomUUID()}`, name: r.fullName, email: email.toLowerCase(), emailVerified: false, username: r.username, role: r.role, canChangePassword: defaultCanChangePassword(r.role), isActive: true, academicYear: r.academicYear ?? null, college: r.college ?? null, collegeId },
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
        // Re-importing resets the user's password (and possibly role): revoke
        // existing sessions so old credentials/roles cannot linger.
        if (existing) {
          await tx.session.deleteMany({ where: { userId: existing.id } });
        }
        if (r.role === "student") {
          await tx.enrollment.deleteMany({ where: { studentId: user.id, termId: term.id } });
          if (r.subjects.length) {
            const subs = await tx.subject.findMany({ where: { code: { in: [...new Set(r.subjects)] } }, select: { id: true } });
            await tx.enrollment.createMany({ data: subs.map((s) => ({ studentId: user.id, subjectId: s.id, termId: term.id })), skipDuplicates: true });
          }
        } else if (r.role === "doctor") {
          await tx.doctorAssignment.deleteMany({ where: { doctorId: user.id, termId: term.id } });
          if (r.taught.length) {
            const subs = await tx.subject.findMany({ where: { code: { in: [...new Set(r.taught)] } }, select: { id: true } });
            await tx.doctorAssignment.createMany({ data: subs.map((s) => ({ doctorId: user.id, subjectId: s.id, termId: term.id })), skipDuplicates: true });
          }
        } else if (r.role === "ta") {
          for (const s of r.sections) {
            const sub = await tx.subject.findUnique({ where: { code: s.code }, select: { id: true } });
            if (!sub) continue;
            for (const name of [...new Set(s.names)]) {
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

// ============================================================================
// Target-First Bulk Student Import (College or Subject + optional Section)
// ============================================================================

interface TargetStudentBatchPayload {
  kind: "target_students";
  target: "college" | "subject";
  collegeId?: string;
  collegeName?: string;
  departmentId?: string | null;
  subjectId?: string;
  termId?: string;
  sectionId?: string | null;
  rows: {
    line: number;
    status: "new" | "existing" | "already_enrolled";
    existingUserId?: string;
    username: string;
    fullName: string;
    email: string;
    academicYear?: number;
    sectionId?: string | null;
    passwordHash?: string;
  }[];
}

// Ephemeral bounded in-memory map for one-time plaintext credential downloads right after commit.
// Plaintext passwords are NEVER written to Postgres, bound to uploadedBy, and capped at 40 batches.
const MAX_PENDING_CRED_BATCHES = 40;
const pendingStudentCredentials = new Map<
  string,
  {
    uploadedBy: string;
    expiresAt: number;
    rows: { username: string; fullName: string; email: string; password: string }[];
  }
>();

function prunePendingCredentials() {
  const now = Date.now();
  for (const [k, v] of pendingStudentCredentials) {
    if (v.expiresAt <= now) pendingStudentCredentials.delete(k);
  }
  while (pendingStudentCredentials.size >= MAX_PENDING_CRED_BATCHES) {
    const oldest = pendingStudentCredentials.keys().next().value;
    if (oldest) pendingStudentCredentials.delete(oldest);
    else break;
  }
}

// GET /api/v1/admin/users/import/students/template?target=college|subject&collegeId=...&subjectId=...
adminImports.get(
  "/students/template",
  rateLimit(60, 60_000, "admin-import:students-template"),
  async (req, res) => {
  const target = String(req.query.target ?? "college") === "subject" ? "subject" : "college";
  const collegeId = typeof req.query.collegeId === "string" && req.query.collegeId.trim() ? req.query.collegeId.trim() : undefined;
  const subjectId = typeof req.query.subjectId === "string" && req.query.subjectId.trim() ? req.query.subjectId.trim() : undefined;

  let targetLabel = target === "college" ? "Target College (selected in portal)" : "Target Subject (selected in portal)";
  let fileSlug = target;
  let sampleSection = "Section A";

  if (target === "college" && collegeId) {
    const col = await prisma.college.findUnique({ where: { id: collegeId }, select: { code: true, name: true } }).catch(() => null);
    if (col) {
      targetLabel = `${col.code} — ${col.name}`;
      fileSlug = `college-${col.code.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
    }
  } else if (target === "subject" && subjectId) {
    const sub = await prisma.subject.findUnique({ where: { id: subjectId }, select: { code: true, name: true } }).catch(() => null);
    if (sub) {
      targetLabel = `${sub.code} — ${sub.name}`;
      fileSlug = `subject-${sub.code.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
      const term = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
      if (term) {
        const sec = await prisma.section.findFirst({
          where: { subjectId, termId: term.id },
          select: { name: true },
          orderBy: { name: "asc" },
        });
        if (sec) sampleSection = sec.name;
      }
    }
  }

  const wb = XLSX.utils.book_new();

  if (target === "college") {
    const sampleRows = [
      {
        student_id: "20260001",
        full_name: "Ahmed Mohamed Hassan",
        email: "20260001@o6u.edu.eg",
        year: 1,
        password: "",
      },
      {
        student_id: "20260002",
        full_name: "سارة محمود علي",
        email: "20260002@o6u.edu.eg",
        year: 1,
        password: "",
      },
      {
        student_id: "20260003",
        full_name: "Omar Khaled Ibrahim",
        email: "",
        year: 2,
        password: "",
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sampleRows, {
      header: ["student_id", "full_name", "email", "year", "password"],
    });
    ws["!cols"] = [{ wch: 16 }, { wch: 28 }, { wch: 26 }, { wch: 8 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, "Students");

    const guide = [
      { Column: "Target", Required: "-", Description: targetLabel, Arabic: "الهدف المحدد من البوابة (لا حاجة لتكراره في الملف)" },
      { Column: "student_id", Required: "Yes", Description: "Unique student ID / username (letters, digits, ., _, -). Also accepts: username, الرقم الجامعي", Arabic: "الرقم الجامعي / اسم المستخدم (مطلوب)" },
      { Column: "full_name", Required: "For new students", Description: "Student full name (English or Arabic). Optional if student already exists. Also accepts: name, اسم الطالب", Arabic: "اسم الطالب الكامل (مطلوب للطلاب الجدد فقط)" },
      { Column: "email", Required: "Optional", Description: "Student email. Auto-generated from student_id if left blank.", Arabic: "البريد الإلكتروني (اختياري)" },
      { Column: "year", Required: "Optional", Description: "Academic year (1 to 7). Uses the default year picked in the UI if blank.", Arabic: "الفرقة الدراسية من 1 إلى 7 (اختياري)" },
      { Column: "password", Required: "Optional", Description: "Initial password for NEW accounts only. Leave blank to auto-generate (existing accounts keep their password).", Arabic: "كلمة المرور للحسابات الجديدة فقط — اتركها فارغة للتوليد التلقائي" },
    ];
    const gws = XLSX.utils.json_to_sheet(guide);
    gws["!cols"] = [{ wch: 14 }, { wch: 16 }, { wch: 62 }, { wch: 52 }];
    XLSX.utils.book_append_sheet(wb, gws, "Guide");
  } else {
    const sampleRows = [
      {
        student_id: "20260001",
        full_name: "Ahmed Mohamed Hassan",
        email: "20260001@o6u.edu.eg",
        section: sampleSection,
        year: 2,
        password: "",
      },
      {
        student_id: "20260002",
        full_name: "سارة محمود علي",
        email: "20260002@o6u.edu.eg",
        section: sampleSection,
        year: 2,
        password: "",
      },
      {
        student_id: "20260003",
        full_name: "Omar Khaled Ibrahim",
        email: "",
        section: "",
        year: 2,
        password: "",
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sampleRows, {
      header: ["student_id", "full_name", "email", "section", "year", "password"],
    });
    ws["!cols"] = [{ wch: 16 }, { wch: 28 }, { wch: 26 }, { wch: 16 }, { wch: 8 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, "Students");

    const guide = [
      { Column: "Target", Required: "-", Description: targetLabel, Arabic: "المقرر المحدد من البوابة (لا حاجة لكتابة كود المقرر في كل صف)" },
      { Column: "student_id", Required: "Yes", Description: "Unique student ID / username (or provide email for existing students). Also accepts: username, الرقم الجامعي", Arabic: "الرقم الجامعي / اسم المستخدم (مطلوب)" },
      { Column: "full_name", Required: "For new students", Description: "Required only when creating brand-new student accounts. Existing students only need student_id or email.", Arabic: "اسم الطالب (مطلوب فقط إذا كان الطالب غير مسجل بالمنصة)" },
      { Column: "email", Required: "Optional", Description: "Student email (can also match an existing student account).", Arabic: "البريد الإلكتروني (اختياري)" },
      { Column: "section", Required: "Optional", Description: "Section name inside this subject (e.g. " + sampleSection + "). Uses the section selected in the UI if left blank.", Arabic: "اسم الشعبة داخل المقرر (اختياري)" },
      { Column: "year", Required: "Optional", Description: "Academic year (1 to 7) for new accounts.", Arabic: "الفرقة الدراسية من 1 إلى 7 (اختياري)" },
      { Column: "password", Required: "Optional", Description: "Initial password for NEW accounts only. Existing students' passwords are never modified.", Arabic: "كلمة المرور للطلاب الجدد فقط (لا يتم تغيير كلمة مرور الطلاب الحاليين)" },
    ];
    const gws = XLSX.utils.json_to_sheet(guide);
    gws["!cols"] = [{ wch: 14 }, { wch: 16 }, { wch: 62 }, { wch: 52 }];
    XLSX.utils.book_append_sheet(wb, gws, "Guide");
  }

  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="o6u-students-${fileSlug}.xlsx"`);
  res.send(out);
});

// POST /api/v1/admin/users/import/students/dry-run
adminImports.post(
  "/students/dry-run",
  rateLimit(30, 60_000, "admin-import:students-dry-run"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    if (!spreadsheetFileOk(req.file.originalname, req.file.mimetype)) {
      return res.status(422).json({ error: "file must be .xlsx/.xls/.csv" });
    }

    const meta = z
      .object({
        target: z.enum(["college", "subject"]),
        collegeId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
        subjectId: z.string().uuid().optional(),
        termId: z.string().uuid().optional(),
        sectionId: z.string().uuid().optional(),
        defaultYear: z.coerce.number().int().min(1).max(7).optional(),
        createMissing: z
          .union([z.boolean(), z.string()])
          .transform((v) => (typeof v === "boolean" ? v : v !== "false"))
          .default(true),
        passwordMode: z.enum(["auto", "student_id", "fixed"]).default("auto"),
        fixedPassword: z.string().optional(),
      })
      .parse({
        target: req.body?.target,
        collegeId: req.body?.collegeId || undefined,
        departmentId: req.body?.departmentId || undefined,
        subjectId: req.body?.subjectId || undefined,
        termId: req.body?.termId || undefined,
        sectionId: req.body?.sectionId || undefined,
        defaultYear: req.body?.defaultYear ? req.body.defaultYear : undefined,
        createMissing: req.body?.createMissing ?? "true",
        passwordMode: req.body?.passwordMode || "auto",
        fixedPassword: req.body?.fixedPassword || undefined,
      });

    if (meta.passwordMode === "fixed" && (!meta.fixedPassword || meta.fixedPassword.length < config.password.minLength)) {
      return res
        .status(422)
        .json({ error: `fixedPassword must be at least ${config.password.minLength} characters` });
    }

    // Resolve and validate target entities
    let college: { id: string; code: string; name: string } | null = null;
    let department: { id: string; code: string; name: string; collegeId: string | null } | null = null;
    let subject: { id: string; code: string; name: string; departmentId: string | null } | null = null;
    let term: { id: string; name: string } | null = null;
    let fixedSection: { id: string; name: string } | null = null;
    let sectionsByName = new Map<string, { id: string; name: string }>();

    if (meta.target === "college") {
      if (!meta.collegeId) return res.status(422).json({ error: "collegeId is required for college import" });
      college = await prisma.college.findUnique({
        where: { id: meta.collegeId },
        select: { id: true, code: true, name: true },
      });
      if (!college) return res.status(404).json({ error: "college not found" });
      if (meta.departmentId) {
        department = await prisma.department.findUnique({
          where: { id: meta.departmentId },
          select: { id: true, code: true, name: true, collegeId: true },
        });
        if (!department) return res.status(404).json({ error: "department not found" });
        if (department.collegeId && department.collegeId !== college.id) {
          return res.status(422).json({ error: "department does not belong to the selected college" });
        }
      }
    } else {
      if (!meta.subjectId) return res.status(422).json({ error: "subjectId is required for subject import" });
      subject = await prisma.subject.findUnique({
        where: { id: meta.subjectId },
        select: { id: true, code: true, name: true, departmentId: true },
      });
      if (!subject) return res.status(404).json({ error: "subject not found" });
      term = meta.termId
        ? await prisma.term.findUnique({ where: { id: meta.termId }, select: { id: true, name: true } })
        : await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
      if (!term) return res.status(409).json({ error: "no active term found" });
      const subSections = await prisma.section.findMany({
        where: { subjectId: subject.id, termId: term.id },
        select: { id: true, name: true },
      });
      sectionsByName = new Map(subSections.map((s) => [s.name.trim().toLowerCase(), s]));
      if (meta.sectionId) {
        const foundSec = subSections.find((s) => s.id === meta.sectionId);
        if (!foundSec) return res.status(422).json({ error: "section not found for this subject and term" });
        fixedSection = foundSec;
      }
      // Also resolve college/department from the subject's department so newly created accounts get proper affiliation
      const dep = subject.departmentId
        ? await prisma.department.findUnique({
            where: { id: subject.departmentId },
            select: { id: true, code: true, name: true, collegeId: true, college: { select: { id: true, code: true, name: true } } },
          })
        : null;
      if (dep) {
        department = { id: dep.id, code: dep.code, name: dep.name, collegeId: dep.collegeId };
        if (dep.college) college = dep.college;
      }
    }

    let parsed: { rows: StudentSheetRow[]; errors: { line: number; reason: string }[] };
    try {
      parsed = parseStudentWorkbook(req.file.buffer);
    } catch (err) {
      return res.status(422).json({ error: err instanceof Error ? err.message : "empty or corrupt file" });
    }
    if (!parsed.rows.length && !parsed.errors.length) {
      return res.status(422).json({ error: "spreadsheet has no student rows" });
    }

    // Bulk lookup existing users by username or email (including synthesized placeholder emails)
    const usernames = [...new Set(parsed.rows.map((r) => r.username).filter(Boolean))];
    const placeholderDomain = config.email.placeholderDomain.toLowerCase();
    const emails = [
      ...new Set(
        parsed.rows
          .flatMap((r) => {
            const out: string[] = [];
            if (r.email) out.push(r.email.toLowerCase());
            if (r.username) out.push(`${r.username.toLowerCase()}@${placeholderDomain}`);
            return out;
          })
          .filter(Boolean),
      ),
    ];
    const existingUsers = await prisma.user.findMany({
      where: {
        OR: [
          ...(usernames.length ? [{ username: { in: usernames } }] : []),
          ...(emails.length ? [{ email: { in: emails } }] : []),
        ],
      },
      select: { id: true, username: true, email: true, name: true, role: true, collegeId: true, departmentId: true, academicYear: true },
    });
    const byUsername = new Map(existingUsers.filter((u) => u.username).map((u) => [u.username!.toLowerCase(), u]));
    const byEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

    // Bulk lookup existing enrollments & section memberships for subject target
    const enrolledIds = new Set<string>();
    const existingMemberships = new Set<string>();
    if (meta.target === "subject" && subject && term && existingUsers.length) {
      const existingIds = existingUsers.map((u) => u.id);
      const [existingEnr, existingSecs] = await Promise.all([
        prisma.enrollment.findMany({
          where: { subjectId: subject.id, termId: term.id, studentId: { in: existingIds } },
          select: { studentId: true },
        }),
        prisma.sectionMembership.findMany({
          where: { section: { subjectId: subject.id, termId: term.id }, studentId: { in: existingIds } },
          select: { studentId: true, sectionId: true },
        }),
      ]);
      for (const e of existingEnr) enrolledIds.add(e.studentId);
      for (const m of existingSecs) existingMemberships.add(`${m.studentId}:${m.sectionId}`);
    }

    const errors = parsed.errors.slice();
    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();
    const validated: {
      line: number;
      status: "new" | "existing" | "already_enrolled";
      existingUserId?: string;
      username: string;
      fullName: string;
      email: string;
      academicYear?: number;
      sectionId?: string | null;
      sectionName?: string | null;
      plainPassword?: string;
    }[] = [];

    for (const r of parsed.rows) {
      const matched = (r.username ? byUsername.get(r.username) : undefined) ?? (r.email ? byEmail.get(r.email) : undefined);

      if (matched) {
        if (matched.role !== "student") {
          errors.push({ line: r.line, reason: `account "${matched.username ?? matched.email}" is a ${matched.role}, not a student` });
          continue;
        }
        const dedupeKey = (matched.username ?? matched.id).toLowerCase();
        if (seenUsernames.has(dedupeKey)) {
          errors.push({ line: r.line, reason: `duplicate student in file: ${matched.username ?? matched.email}` });
          continue;
        }
        seenUsernames.add(dedupeKey);

        let secId: string | null = fixedSection?.id ?? null;
        let secName: string | null = fixedSection?.name ?? null;
        if (meta.target === "subject" && !secId && r.sectionName) {
          const sec = sectionsByName.get(r.sectionName.trim().toLowerCase());
          if (!sec) {
            errors.push({ line: r.line, reason: `unknown section "${r.sectionName}" in ${subject?.code}` });
            continue;
          }
          secId = sec.id;
          secName = sec.name;
        }

        const alreadyEnrolled =
          meta.target === "subject"
            ? enrolledIds.has(matched.id) && (!secId || existingMemberships.has(`${matched.id}:${secId}`))
            : matched.collegeId === college?.id &&
              (!meta.departmentId || matched.departmentId === meta.departmentId) &&
              (r.academicYear === undefined || matched.academicYear === r.academicYear);

        validated.push({
          line: r.line,
          status: alreadyEnrolled ? "already_enrolled" : "existing",
          existingUserId: matched.id,
          username: matched.username ?? r.username,
          fullName: r.fullName || matched.name,
          email: matched.email,
          academicYear: r.academicYear ?? meta.defaultYear,
          sectionId: secId,
          sectionName: secName,
        });
        continue;
      }

      // Brand-new student account
      if (meta.target === "subject" && !meta.createMissing) {
        errors.push({ line: r.line, reason: `student "${r.username || r.email}" not found in portal` });
        continue;
      }
      if (!r.username) {
        errors.push({ line: r.line, reason: "student_id / username is required to create a new account" });
        continue;
      }
      if (!r.fullName) {
        errors.push({ line: r.line, reason: `full_name is required for new student "${r.username}"` });
        continue;
      }
      if (seenUsernames.has(r.username)) {
        errors.push({ line: r.line, reason: `duplicate student_id in file: ${r.username}` });
        continue;
      }
      const computedEmail = (r.email || `${r.username}@${config.email.placeholderDomain}`).toLowerCase();
      if (seenEmails.has(computedEmail) || byEmail.has(computedEmail)) {
        errors.push({ line: r.line, reason: `email already used: ${computedEmail}` });
        continue;
      }

      let secId: string | null = fixedSection?.id ?? null;
      let secName: string | null = fixedSection?.name ?? null;
      if (meta.target === "subject" && !secId && r.sectionName) {
        const sec = sectionsByName.get(r.sectionName.trim().toLowerCase());
        if (!sec) {
          errors.push({ line: r.line, reason: `unknown section "${r.sectionName}" in ${subject?.code}` });
          continue;
        }
        secId = sec.id;
        secName = sec.name;
      }

      let plainPassword = r.password ?? "";
      if (plainPassword) {
        if (plainPassword.length < config.password.minLength) {
          errors.push({ line: r.line, reason: `password must be at least ${config.password.minLength} characters` });
          continue;
        }
      } else if (meta.passwordMode === "fixed") {
        plainPassword = meta.fixedPassword!;
      } else if (meta.passwordMode === "student_id") {
        plainPassword =
          r.username.length >= config.password.minLength
            ? r.username
            : `${r.username}00000000`.slice(0, config.password.minLength);
      } else {
        plainPassword = generateReadablePassword();
      }

      seenUsernames.add(r.username);
      seenEmails.add(computedEmail);
      validated.push({
        line: r.line,
        status: "new",
        username: r.username,
        fullName: r.fullName,
        email: computedEmail,
        academicYear: r.academicYear ?? meta.defaultYear,
        sectionId: secId,
        sectionName: secName,
        plainPassword,
      });
    }

    // Hash ONLY newly created accounts (in parallel chunks) — existing students need zero hashing!
    const storedRows: TargetStudentBatchPayload["rows"] = [];
    const credsForMemory: { username: string; fullName: string; email: string; password: string }[] = [];
    const n = config.importBatch.hashConcurrency;
    for (let i = 0; i < validated.length; i += n) {
      const chunk = await Promise.all(
        validated.slice(i, i + n).map(async (r) => {
          if (r.status === "new" && r.plainPassword) {
            const passwordHash = await hashPassword(r.plainPassword);
            credsForMemory.push({
              username: r.username,
              fullName: r.fullName,
              email: r.email,
              password: r.plainPassword,
            });
            return {
              line: r.line,
              status: r.status,
              username: r.username,
              fullName: r.fullName,
              email: r.email,
              academicYear: r.academicYear,
              sectionId: r.sectionId,
              passwordHash,
            };
          }
          return {
            line: r.line,
            status: r.status,
            existingUserId: r.existingUserId,
            username: r.username,
            fullName: r.fullName,
            email: r.email,
            academicYear: r.academicYear,
            sectionId: r.sectionId,
          };
        }),
      );
      storedRows.push(...chunk);
    }

    const me = (req as unknown as AuthedRequest).userId;
    const expiresAt = new Date(Date.now() + config.importBatch.ttlMs);
    const payload: TargetStudentBatchPayload = {
      kind: "target_students",
      target: meta.target,
      collegeId: college?.id,
      collegeName: college?.name,
      departmentId: department?.id ?? null,
      subjectId: subject?.id,
      termId: term?.id,
      sectionId: fixedSection?.id ?? null,
      rows: storedRows,
    };

    const batch = await prisma.importBatch.create({
      data: {
        type: "users",
        uploadedBy: me,
        filename: req.file.originalname,
        status: "dry_run",
        totalRows: parsed.rows.length + parsed.errors.length,
        validRows: validated.length,
        payload: JSON.parse(JSON.stringify(payload)),
        expiresAt,
      },
    });

    prunePendingCredentials();
    if (credsForMemory.length > 0) {
      pendingStudentCredentials.set(batch.id, {
        uploadedBy: me,
        expiresAt: expiresAt.getTime(),
        rows: credsForMemory,
      });
    }

    const newCount = validated.filter((r) => r.status === "new").length;
    const existingCount = validated.filter((r) => r.status === "existing").length;
    const alreadyCount = validated.filter((r) => r.status === "already_enrolled").length;

    res.json({
      batchId: batch.id,
      target: meta.target,
      targetSummary: {
        college: college ? { id: college.id, code: college.code, name: college.name } : null,
        department: department ? { id: department.id, code: department.code, name: department.name } : null,
        subject: subject ? { id: subject.id, code: subject.code, name: subject.name } : null,
        term: term ? { id: term.id, name: term.name } : null,
        section: fixedSection ? { id: fixedSection.id, name: fixedSection.name } : null,
      },
      counts: {
        total: parsed.rows.length + parsed.errors.length,
        valid: validated.length,
        newAccounts: newCount,
        existingStudents: existingCount,
        alreadyEnrolled: alreadyCount,
        errors: errors.length,
      },
      errors,
      preview: validated.slice(0, 60).map((r) => ({
        line: r.line,
        status: r.status,
        username: r.username,
        fullName: r.fullName,
        email: r.email,
        academicYear: r.academicYear ?? null,
        sectionName: r.sectionName ?? null,
      })),
      previewTruncated: validated.length > 60,
      expiresAt: batch.expiresAt,
    });
  },
);

// POST /api/v1/admin/users/import/students/commit
adminImports.post(
  "/students/commit",
  rateLimit(30, 60_000, "admin-import:students-commit"),
  async (req, res) => {
    const { batchId } = z.object({ batchId: z.string() }).parse(req.body);
    const me = (req as unknown as AuthedRequest).userId;

    // Pre-verify ownership & payload kind BEFORE claiming to prevent type confusion or cross-admin hijacking.
    const pre = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { status: true, expiresAt: true, type: true, uploadedBy: true, payload: true },
    });
    if (!pre || pre.type !== "users") return res.status(404).json({ error: "batch not found" });
    if (pre.uploadedBy !== me) {
      return res.status(403).json({ error: "only the admin who validated this batch can commit it" });
    }
    const prePayload = pre.payload as unknown as Partial<TargetStudentBatchPayload> | null;
    if (!prePayload || prePayload.kind !== "target_students" || !Array.isArray(prePayload.rows)) {
      return res.status(400).json({ error: "invalid student batch payload" });
    }

    const claimed = await prisma.importBatch.updateMany({
      where: { id: batchId, type: "users", uploadedBy: me, status: "dry_run", expiresAt: { gt: new Date() } },
      data: { status: "committed" },
    });
    if (claimed.count === 0) {
      if (pre.status === "dry_run" && pre.expiresAt.getTime() < Date.now()) {
        await prisma.importBatch.updateMany({
          where: { id: batchId, status: "dry_run" },
          data: { status: "expired", payload: {} },
        });
        pendingStudentCredentials.delete(batchId);
        return res.status(409).json({ error: "batch expired" });
      }
      return res.status(409).json({ error: `already ${pre.status}` });
    }

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    const payload = batch.payload as unknown as TargetStudentBatchPayload;

    let created = 0;
    let updated = 0;
    let enrolled = 0;
    let sectionAssigned = 0;
    let skipped = 0;
    const rowErrors: { line: number; reason: string }[] = [];
    const actuallyCreatedUsernames = new Set<string>();

    const CHUNK = 200;
    for (let i = 0; i < payload.rows.length; i += CHUNK) {
      const slice = payload.rows.slice(i, i + CHUNK);
      const newRows = slice.filter((r) => r.status === "new" && r.passwordHash);
      const existingRows = slice.filter((r) => r.status !== "new" && r.existingUserId);

      try {
        const chunkResult = await prisma.$transaction(async (tx) => {
          let chunkCreated = 0;
          let chunkUpdated = 0;
          let chunkEnrolled = 0;
          let chunkSectionAssigned = 0;
          let chunkSkipped = 0;
          const chunkRowErrors: { line: number; reason: string }[] = [];
          const chunkCreatedUsernames: string[] = [];

          // Map of line -> verified student userId for enrollment/section step
          const userIdByLine = new Map<number, string>();
          for (const r of existingRows) userIdByLine.set(r.line, r.existingUserId!);

          // 1. Bulk create new student users + credential accounts
          if (newRows.length > 0) {
            const prepared = newRows.map((r) => ({
              row: r,
              id: `u_${crypto.randomUUID()}`,
            }));
            await tx.user.createMany({
              data: prepared.map(({ row, id }) => ({
                id,
                name: row.fullName,
                email: row.email,
                emailVerified: false,
                username: row.username,
                role: "student" as const,
                canChangePassword: defaultCanChangePassword("student"),
                isActive: true,
                academicYear: row.academicYear ?? null,
                college: payload.collegeName ?? null,
                collegeId: payload.collegeId ?? null,
                departmentId: payload.departmentId ?? null,
              })),
              skipDuplicates: true,
            });

            // Query strictly by our newly generated IDs so a race conflict with
            // an existing non-student or concurrently created user can never be
            // misattributed, enrolled, or returned as newly created credentials.
            const insertedUsers = await tx.user.findMany({
              where: { id: { in: prepared.map((p) => p.id) } },
              select: { id: true, username: true },
            });
            const insertedIds = new Set(insertedUsers.map((u) => u.id));
            chunkCreated = insertedUsers.length;

            const accountsToCreate: {
              id: string;
              providerId: string;
              accountId: string;
              userId: string;
              password: string;
            }[] = [];
            for (const { row, id } of prepared) {
              if (insertedIds.has(id)) {
                userIdByLine.set(row.line, id);
                chunkCreatedUsernames.push(row.username.toLowerCase());
                accountsToCreate.push({
                  id: `acc-${id}`,
                  providerId: "credential",
                  accountId: id,
                  userId: id,
                  password: row.passwordHash!,
                });
              } else {
                chunkRowErrors.push({
                  line: row.line,
                  reason: `account conflict during commit for "${row.username}" (username or email already exists)`,
                });
              }
            }
            if (accountsToCreate.length > 0) {
              await tx.account.createMany({ data: accountsToCreate, skipDuplicates: true });
            }
          }

          // 2. Update existing students' college/department/year when importing to college
          if (payload.target === "college" && existingRows.length > 0 && payload.collegeId) {
            for (const r of existingRows) {
              if (r.status === "already_enrolled") {
                chunkSkipped++;
                continue;
              }
              await tx.user.update({
                where: { id: r.existingUserId! },
                data: {
                  college: payload.collegeName ?? undefined,
                  collegeId: payload.collegeId,
                  ...(payload.departmentId ? { departmentId: payload.departmentId } : {}),
                  ...(r.academicYear !== undefined ? { academicYear: r.academicYear } : {}),
                },
              });
              chunkUpdated++;
            }
          } else if (payload.target === "subject") {
            for (const r of existingRows) {
              if (r.status === "already_enrolled") chunkSkipped++;
            }
          }

          // 3. Bulk enroll & assign sections for subject target
          if (payload.target === "subject" && payload.subjectId && payload.termId) {
            const enrollData: { studentId: string; subjectId: string; termId: string }[] = [];
            const secData: { sectionId: string; studentId: string }[] = [];
            for (const r of slice) {
              const uid = userIdByLine.get(r.line);
              if (!uid) continue;
              enrollData.push({ studentId: uid, subjectId: payload.subjectId, termId: payload.termId });
              if (r.sectionId) {
                secData.push({ sectionId: r.sectionId, studentId: uid });
              }
            }
            if (enrollData.length > 0) {
              const enrRes = await tx.enrollment.createMany({ data: enrollData, skipDuplicates: true });
              chunkEnrolled = enrRes.count;
            }
            if (secData.length > 0) {
              const secRes = await tx.sectionMembership.createMany({ data: secData, skipDuplicates: true });
              chunkSectionAssigned = secRes.count;
            }
          }

          return {
            chunkCreated,
            chunkUpdated,
            chunkEnrolled,
            chunkSectionAssigned,
            chunkSkipped,
            chunkRowErrors,
            chunkCreatedUsernames,
          };
        });

        created += chunkResult.chunkCreated;
        updated += chunkResult.chunkUpdated;
        enrolled += chunkResult.chunkEnrolled;
        sectionAssigned += chunkResult.chunkSectionAssigned;
        skipped += chunkResult.chunkSkipped;
        rowErrors.push(...chunkResult.chunkRowErrors);
        for (const u of chunkResult.chunkCreatedUsernames) actuallyCreatedUsernames.add(u);
      } catch (err) {
        rowErrors.push({
          line: slice[0]?.line ?? 2,
          reason: err instanceof Error ? err.message : "chunk commit failed",
        });
      }
    }

    const credEntry = pendingStudentCredentials.get(batch.id);
    const memCreds =
      credEntry && credEntry.uploadedBy === me
        ? credEntry.rows.filter((c) => actuallyCreatedUsernames.has(c.username.toLowerCase()))
        : [];
    pendingStudentCredentials.delete(batch.id);

    const imported = created + updated + enrolled;
    await prisma.importBatch.update({ where: { id: batch.id }, data: { payload: {} } });
    const log = await prisma.excelImportLog.create({
      data: {
        importType: "users",
        batchId: batch.id,
        uploadedBy: me,
        filename: batch.filename,
        totalRows: batch.totalRows,
        importedCount: created + updated + enrolled,
        errorCount: rowErrors.length,
        errorReport: rowErrors,
      },
    });
    await audit(me, "import.students.commit", "import_batch", batch.id, {
      target: payload.target,
      collegeId: payload.collegeId,
      subjectId: payload.subjectId,
      created,
      updated,
      enrolled,
      sectionAssigned,
      skipped,
      errors: rowErrors.length,
    });

    res.json({
      ok: true,
      imported,
      created,
      updated,
      enrolled,
      sectionAssigned,
      skipped,
      errors: rowErrors,
      credentials: memCreds,
      logId: log.id,
    });
  },
);

// POST /api/v1/admin/users/import/students/credentials-xlsx — stateless XLSX formatter for newly created accounts
adminImports.post(
  "/students/credentials-xlsx",
  rateLimit(30, 60_000, "admin-import:credentials-xlsx"),
  async (req, res) => {
    const body = z
      .object({
        rows: z
          .array(
            z.object({
              username: z.string().max(120),
              fullName: z.string().max(200),
              email: z.string().max(260),
              password: z.string().max(200),
            }),
          )
          .min(1)
          .max(5000),
        label: z.string().max(80).optional(),
      })
      .parse(req.body);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(
      body.rows.map((r, i) => ({
        "#": i + 1,
        student_id: safeExcelCell(r.username),
        full_name: safeExcelCell(r.fullName),
        email: safeExcelCell(r.email),
        initial_password: safeExcelCell(r.password),
      })),
    );
    ws["!cols"] = [{ wch: 6 }, { wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, "New Student Credentials");

    const slug = (body.label || "students").replace(/[^a-zA-Z0-9_-]+/g, "_");
    const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="o6u-credentials-${slug}.xlsx"`);
    res.send(out);
  },
);
