import { Router, type Router as RouterType } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { hashEntryCode } from "../lib/sebCrypto.js";
import { checkMix, checkWindow, mixShortfall, poolCounts } from "../lib/examRules.js";
import { Prisma } from "../generated/prisma/client.js";
import { poolForExam } from "../lib/sampling.js";
import { sniffMedia, storage } from "../lib/storage.js";
import { QUESTION_TYPES, safeJsonParse, scoreQuestionAnswer, type QuestionTypeValue } from "../lib/questionTypes.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { hasPermission, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const exams: RouterType = Router();
exams.use(requireAuth);

const INSTRUCTION_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const instructionMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INSTRUCTION_MEDIA_MAX_BYTES },
});
const studentListUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxBytes },
});
const MEDIA_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".webm", ".mp4", ".mov"] as const;
function mediaExtOk(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && (MEDIA_EXTS as readonly string[]).includes(filename.slice(dot).toLowerCase());
}
function spreadsheetFileOk(filename: string, mimetype: string): boolean {
  const lower = filename.toLowerCase();
  if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv"))) return false;
  if (/spreadsheet|excel|csv|text\/plain|octet-stream/.test(mimetype.toLowerCase())) return true;
  return false;
}

const mixInput = z.record(z.string(), z.number().int().min(0));

async function currentTermId(): Promise<string | null> {
  const t = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
  return t?.id ?? null;
}

// Pool a new exam samples from: doctor → own private bank; TA → shared or own-only.
export async function poolWhere(
  creatorId: string,
  role: string,
  subjectId: string,
  source: "own" | "shared" | "mine",
): Promise<{ ok: true; where: object } | { ok: false; error: string }> {
  if (role === "doctor") {
    if (source !== "own") return { ok: false, error: "doctor exams sample own bank only" };
    return { ok: true, where: { subjectId, ownerType: "doctor", doctorId: creatorId } };
  }
  if (role === "ta") {
    if (source !== "shared" && source !== "mine") return { ok: false, error: "choose shared|mine" };
    return { ok: true, where: { subjectId, ownerType: "ta_shared", ...(source === "mine" ? { addedByTaId: creatorId } : {}) } };
  }
  return { ok: true, where: { subjectId } }; // admin preview path
}

// GET /exams/subjects — subjects the caller may work in (current term).
// Doctor: assigned subjects. TA: subjects of own sections. Students: 403.
exams.get("/subjects", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const termId = await currentTermId();
  if (!termId) return res.json(envelope(0, { page: 1, limit: 1 }, []));
  if (a.role === "doctor") {
    const rows = await prisma.doctorAssignment.findMany({
      where: { doctorId: a.userId, termId },
      select: { subject: { select: { id: true, code: true, name: true } } },
    });
    const subjects = rows.map((r) => r.subject);
    return res.json(envelope(subjects.length, { page: 1, limit: Math.max(subjects.length, 1) }, subjects));
  }
  if (a.role === "ta") {
    const secs = await prisma.section.findMany({
      where: { taId: a.userId, termId },
      select: { subject: { select: { id: true, code: true, name: true } } },
    });
    const seen = new Map(secs.map((s) => [s.subject.id, s.subject]));
    const subjects = [...seen.values()];
    return res.json(envelope(subjects.length, { page: 1, limit: Math.max(subjects.length, 1) }, subjects));
  }
  const all = await prisma.subject.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  res.json(envelope(all.length, { page: 1, limit: Math.max(all.length, 1) }, all));
});

// GET /exams/sections?subject_id* — section picker backing the quiz builder.
// TA: own sections only (enforced). Doctor: assigned subjects only (a prior
// listing leaked every subject's sections + TA names + seat counts).
// Admin: all sections of the subject in the current term. Students: 403.
exams.get("/sections", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ subject_id: z.string() }).parse(req.query);
  const termId = await currentTermId();
  if (!termId) return res.json(envelope(0, { page: 1, limit: 1 }, []));
  if (a.role === "doctor") {
    const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: q.subject_id, termId } });
    if (!assigned) return res.status(403).json({ error: "not assigned to subject for this term" });
  }
  const rows = await prisma.section.findMany({
    where: { subjectId: q.subject_id, termId, ...(a.role === "ta" ? { taId: a.userId } : {}) },
    select: {
      id: true, name: true,
      ta: { select: { id: true, name: true, username: true } },
      _count: { select: { memberships: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json(envelope(rows.length, { page: 1, limit: Math.max(rows.length, 1) }, rows));
});

// GET /exams/roster?subject_id* — who is in my subject: sections with their
// TA and enrolled students. Same scope rule as /sections: doctor sees only
// assigned subjects, TA only own sections, admin everything. Students: 403.
// Powers the staff Roster page (per-exam results show sittings; this shows people).
exams.get("/roster", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ subject_id: z.string() }).parse(req.query);
  const termId = await currentTermId();
  if (!termId) return res.json({ subjectId: q.subject_id, termId: null, sections: [] });
  if (a.role === "doctor") {
    const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: q.subject_id, termId } });
    if (!assigned) return res.status(403).json({ error: "not assigned to subject for this term" });
  }
  const [sections, total, enrolledRows] = await Promise.all([
    prisma.section.findMany({
      where: { subjectId: q.subject_id, termId, ...(a.role === "ta" ? { taId: a.userId } : {}) },
      select: {
        id: true, name: true,
        ta: { select: { id: true, name: true, username: true } },
        memberships: {
          select: {
            student: {
              select: {
                id: true,
                username: true,
                name: true,
                email: true,
                isActive: true,
                academicYear: true,
                college: true,
                collegeRef: { select: { id: true, code: true, name: true } },
                department: { select: { id: true, code: true, name: true } },
              },
            },
          },
          orderBy: { student: { name: "asc" } },
          take: config.lists.membersMax,
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.enrollment.count({ where: { subjectId: q.subject_id, termId } }),
    a.role === "ta"
      ? Promise.resolve([])
      : prisma.enrollment.findMany({
          where: { subjectId: q.subject_id, termId },
          select: {
            student: {
              select: {
                id: true,
                username: true,
                name: true,
                email: true,
                isActive: true,
                academicYear: true,
                college: true,
                collegeRef: { select: { id: true, code: true, name: true } },
                department: { select: { id: true, code: true, name: true } },
              },
            },
          },
          orderBy: { student: { name: "asc" } },
          take: config.lists.membersMax,
        }),
  ]);
  const taUniqueStudents =
    a.role === "ta"
      ? new Set(sections.flatMap((s) => s.memberships.map((m) => m.student.id))).size
      : total;
  await audit(a.userId, "roster.view", "subject", q.subject_id, { sections: sections.length }).catch(() => {});
  res.json({
    subjectId: q.subject_id,
    termId,
    totalEnrolled: taUniqueStudents,
    enrolledStudents: enrolledRows.map((e) => e.student),
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      ta: s.ta,
      students: s.memberships.map((m) => m.student),
    })),
  });
});

function toSafeExam<T extends { accessCodeHash: string | null }>(exam: T) {
  const { accessCodeHash, ...safe } = exam;
  return { ...safe, hasAccessCode: accessCodeHash !== null };
}

// GET /exams/import-students/template — downloads a ready-to-fill .xlsx
// template for importing exam-eligible students. Optional ?subject_id=&prefill=true
// prefills the caller's current-term roster for that subject.
exams.get("/import-students/template", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z
    .object({
      subject_id: z.string().optional(),
      prefill: z.enum(["true", "false"]).optional(),
    })
    .parse(req.query);

  const rows: (string | number)[][] = [["username", "email", "full_name"]];
  let filename = "exam-students-template.xlsx";

  if (q.subject_id && q.prefill === "true") {
    const termId = await currentTermId();
    if (termId) {
      let allowed = a.role === "admin";
      if (a.role === "doctor") {
        allowed = (await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: q.subject_id, termId } })) > 0;
      } else if (a.role === "ta") {
        allowed = (await prisma.section.count({ where: { taId: a.userId, subjectId: q.subject_id, termId } })) > 0;
      }
      if (!allowed) return res.status(403).json({ error: "not assigned to subject for this term" });
      const subj = await prisma.subject.findUnique({ where: { id: q.subject_id }, select: { code: true } });
      if (subj) filename = `${subj.code}-students.xlsx`;
      if (a.role === "ta") {
        const secs = await prisma.section.findMany({
          where: { taId: a.userId, subjectId: q.subject_id, termId },
          select: {
            memberships: {
              select: { student: { select: { id: true, username: true, email: true, name: true, isActive: true } } },
              take: config.lists.examTargetsMax,
            },
          },
        });
        const seen = new Set<string>();
        for (const sec of secs) {
          for (const m of sec.memberships) {
            if (!m.student.isActive || seen.has(m.student.id)) continue;
            seen.add(m.student.id);
            rows.push([m.student.username ?? "", m.student.email, m.student.name]);
          }
        }
      } else {
        const enrolled = await prisma.enrollment.findMany({
          where: { subjectId: q.subject_id, termId },
          select: { student: { select: { username: true, email: true, name: true, isActive: true } } },
          orderBy: { student: { name: "asc" } },
          take: config.lists.examTargetsMax,
        });
        for (const e of enrolled) {
          if (!e.student.isActive) continue;
          rows.push([e.student.username ?? "", e.student.email, e.student.name]);
        }
      }
    }
  }
  if (rows.length === 1) {
    rows.push(["student1", "student1@uni.local", "Sample Student One"]);
    rows.push(["student2", "student2@uni.local", "Sample Student Two"]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 22 }, { wch: 30 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws, "Students");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`);
  res.send(buf);
});

// POST /exams/import-students (multipart file=, subjectId=, enrolledOnly?)
// Validates an uploaded .xlsx/.xls/.csv student list for exam targeting and
// resolves each valid row to a real active student account.
exams.post(
  "/import-students",
  rateLimit(30, 60_000, "exam:import-students"),
  studentListUpload.single("file"),
  async (req, res) => {
    const a = req as unknown as AuthedRequest;
    if (a.role === "student") return res.status(403).json({ error: "forbidden" });
    const permErr = await creatorPermissionError(a.userId, a.role);
    if (permErr) return res.status(403).json(permErr);

    const body = z
      .object({
        subjectId: z.string().min(1),
        enrolledOnly: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
      })
      .parse(req.body ?? {});

    const termId = await currentTermId();
    if (!termId) return res.status(409).json({ error: "no current term" });
    const subject = await prisma.subject.findUnique({ where: { id: body.subjectId }, select: { id: true, code: true, name: true } });
    if (!subject) return res.status(404).json({ error: "subject not found" });

    if (a.role === "doctor") {
      const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: body.subjectId, termId } });
      if (!assigned) return res.status(403).json({ error: "not assigned to subject for this term" });
    } else if (a.role === "ta") {
      const teaches = await prisma.section.count({ where: { taId: a.userId, subjectId: body.subjectId, termId } });
      if (!teaches) return res.status(403).json({ error: "not assigned to any section of this subject for this term" });
    }

    if (!req.file) return res.status(400).json({ error: "file required" });
    if (!spreadsheetFileOk(req.file.originalname, req.file.mimetype)) {
      return res.status(422).json({ error: "file must be .xlsx, .xls, or .csv" });
    }

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch {
      return res.status(422).json({ error: "empty or corrupt spreadsheet file" });
    }
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet || !wb.Sheets[firstSheet]) {
      return res.status(422).json({ error: "spreadsheet has no worksheets" });
    }
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[firstSheet], { header: 1, defval: "" });
    if (!matrix.length) {
      return res.status(422).json({ error: "spreadsheet is empty" });
    }

    const normKey = (v: unknown) =>
      String(v ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s\-]+/g, "_")
        .replace(/[^a-z0-9_]/g, "");

    const headerRow = (matrix[0] ?? []).map((h) => String(h ?? "").trim());
    const normHeaders = headerRow.map(normKey);
    const USERNAME_ALIASES = new Set([
      "username",
      "user_name",
      "student_id",
      "studentid",
      "student_username",
      "student_code",
      "university_id",
      "uni_id",
      "id",
      "code",
    ]);
    const EMAIL_ALIASES = new Set(["email", "e_mail", "student_email", "mail"]);
    const NAME_ALIASES = new Set(["name", "full_name", "fullname", "student_name"]);

    const usernameIdx = normHeaders.findIndex((h) => USERNAME_ALIASES.has(h));
    const emailIdx = normHeaders.findIndex((h) => EMAIL_ALIASES.has(h));
    const nameIdx = normHeaders.findIndex((h) => NAME_ALIASES.has(h));
    const detectedColumns = headerRow.filter(Boolean);

    if (usernameIdx < 0 && emailIdx < 0) {
      return res.status(422).json({
        error: "Spreadsheet must include a 'username' (or 'student_id') or 'email' column in the first row.",
        detectedColumns,
      });
    }

    const maxParsedRows = Math.max(2000, config.lists.examTargetsMax * 4);
    const dataRows = matrix.slice(1);
    if (dataRows.length > maxParsedRows) {
      return res.status(422).json({ error: `Spreadsheet exceeds maximum of ${maxParsedRows} rows.` });
    }

    const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,120}$/;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    interface ParsedRow {
      line: number;
      username: string;
      email: string;
      name: string;
      displayVal: string;
    }

    const parsed: ParsedRow[] = [];
    const errors: { line: number; value: string; reason: string }[] = [];
    const duplicates: { line: number; firstLine: number; value: string }[] = [];
    let nonEmptyRows = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] ?? [];
      const line = i + 2;
      const rawUser = usernameIdx >= 0 ? String(row[usernameIdx] ?? "").trim() : "";
      const rawEmail = emailIdx >= 0 ? String(row[emailIdx] ?? "").trim() : "";
      const rawName = nameIdx >= 0 ? String(row[nameIdx] ?? "").trim() : "";
      // Skip completely empty trailing/spacer rows.
      if (!rawUser && !rawEmail && !rawName && row.every((c) => !String(c ?? "").trim())) continue;
      nonEmptyRows++;

      const displayVal = rawUser || rawEmail || rawName || `Row ${line}`;
      if (!rawUser && !rawEmail) {
        errors.push({ line, value: displayVal, reason: "Missing username or email" });
        continue;
      }
      const username = rawUser.toLowerCase();
      const email = rawEmail.toLowerCase();
      if (username && !USERNAME_RE.test(username)) {
        errors.push({ line, value: rawUser, reason: "Invalid username format (allowed: letters, numbers, _, ., -)" });
        continue;
      }
      if (email && !EMAIL_RE.test(email)) {
        errors.push({ line, value: rawEmail, reason: "Invalid email format" });
        continue;
      }
      parsed.push({ line, username, email, name: rawName, displayVal });
    }

    if (nonEmptyRows === 0) {
      return res.status(422).json({ error: "Spreadsheet has headers but no student rows." });
    }

    // Batch lookup all referenced usernames and emails in a single DB query.
    const allUsernames = [...new Set(parsed.map((r) => r.username).filter(Boolean))];
    const allEmails = [...new Set(parsed.map((r) => r.email).filter(Boolean))];
    const matchedUsers =
      allUsernames.length || allEmails.length
        ? await prisma.user.findMany({
            where: {
              OR: [
                ...(allUsernames.length ? [{ username: { in: allUsernames } }] : []),
                ...(allEmails.length ? [{ email: { in: allEmails } }] : []),
              ],
            },
            select: { id: true, username: true, email: true, name: true, role: true, isActive: true },
          })
        : [];

    const byUsername = new Map<string, (typeof matchedUsers)[number]>();
    const byEmail = new Map<string, (typeof matchedUsers)[number]>();
    for (const u of matchedUsers) {
      if (u.username) byUsername.set(u.username.toLowerCase(), u);
      byEmail.set(u.email.toLowerCase(), u);
    }

    const matchedIds = matchedUsers.filter((u) => u.role === "student").map((u) => u.id);
    const [enrollments, sectionMemberships] = matchedIds.length
      ? await Promise.all([
          prisma.enrollment.findMany({
            where: { subjectId: body.subjectId, termId, studentId: { in: matchedIds } },
            select: { studentId: true },
          }),
          prisma.sectionMembership.findMany({
            where: { studentId: { in: matchedIds }, section: { subjectId: body.subjectId, termId } },
            select: { studentId: true, section: { select: { name: true, taId: true } } },
          }),
        ])
      : [[], []];

    const enrolledSet = new Set(enrollments.map((e) => e.studentId));
    const sectionsByStudent = new Map<string, { names: string[]; inMySections: boolean }>();
    for (const m of sectionMemberships) {
      const entry = sectionsByStudent.get(m.studentId) ?? { names: [], inMySections: false };
      if (!entry.names.includes(m.section.name)) entry.names.push(m.section.name);
      if (m.section.taId === a.userId) entry.inMySections = true;
      sectionsByStudent.set(m.studentId, entry);
    }

    const seenUserFirstLine = new Map<string, number>();
    const validStudents: {
      line: number;
      id: string;
      username: string | null;
      name: string;
      email: string;
      enrolled: boolean;
      sectionNames: string[];
      inMySections: boolean;
      warnings: string[];
    }[] = [];

    for (const r of parsed) {
      const uByName = r.username ? byUsername.get(r.username) : undefined;
      const uByEmail = r.email ? byEmail.get(r.email) : undefined;
      if (uByName && uByEmail && uByName.id !== uByEmail.id) {
        errors.push({ line: r.line, value: r.displayVal, reason: "Username and email belong to different accounts" });
        continue;
      }
      const user = uByName ?? uByEmail;
      if (!user) {
        errors.push({ line: r.line, value: r.displayVal, reason: `Student not found (${r.displayVal})` });
        continue;
      }
      if (user.role !== "student") {
        errors.push({ line: r.line, value: r.displayVal, reason: `Account is a ${user.role}, not a student` });
        continue;
      }
      if (!user.isActive) {
        errors.push({ line: r.line, value: r.displayVal, reason: "Student account is inactive" });
        continue;
      }
      const firstLine = seenUserFirstLine.get(user.id);
      if (firstLine !== undefined) {
        duplicates.push({ line: r.line, firstLine, value: user.username ?? user.email });
        continue;
      }
      const enrolled = enrolledSet.has(user.id);
      const secInfo = sectionsByStudent.get(user.id) ?? { names: [], inMySections: false };
      if (body.enrolledOnly && !enrolled) {
        errors.push({ line: r.line, value: r.displayVal, reason: "Not enrolled in this subject" });
        continue;
      }
      if (validStudents.length >= config.lists.examTargetsMax) {
        errors.push({
          line: r.line,
          value: r.displayVal,
          reason: `Exceeds maximum of ${config.lists.examTargetsMax} targeted students per exam`,
        });
        continue;
      }
      seenUserFirstLine.set(user.id, r.line);

      const warnings: string[] = [];
      if (!enrolled) {
        warnings.push("Not enrolled in subject (will still be granted access via this exam's student list)");
      } else if (a.role === "ta" && !secInfo.inMySections) {
        warnings.push("Enrolled in subject but not in your sections");
      }
      if (r.name && r.name.toLowerCase() !== user.name.trim().toLowerCase()) {
        warnings.push(`Spreadsheet name "${r.name}" differs from account name "${user.name}"`);
      }

      validStudents.push({
        line: r.line,
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        enrolled,
        sectionNames: secInfo.names,
        inMySections: secInfo.inMySections,
        warnings,
      });
    }

    await audit(a.userId, "exam.import-students.validate", "subject", body.subjectId, {
      filename: req.file.originalname,
      totalRows: nonEmptyRows,
      valid: validStudents.length,
      errors: errors.length,
      duplicates: duplicates.length,
    });

    res.json({
      filename: req.file.originalname,
      sheetName: firstSheet,
      detectedColumns,
      totalRows: nonEmptyRows,
      validCount: validStudents.length,
      errorCount: errors.length,
      duplicateCount: duplicates.length,
      warningCount: validStudents.filter((s) => s.warnings.length > 0).length,
      maxAllowed: config.lists.examTargetsMax,
      students: validStudents,
      errors,
      duplicates,
    });
  },
);

// GET /exams/mine?term_id&status&include_subject — staff's own creations (plus
// subject TA quizzes for doctors with view_all_grades when include_subject=true).
exams.get("/mine", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = pageQuery
    .extend({
      term_id: z.string().optional(),
      status: z.string().optional(),
      include_subject: z.enum(["true", "false"]).optional(),
    })
    .parse(req.query);
  const termId = q.term_id ?? (await currentTermId());
  let where: Prisma.ExamWhereInput = {
    createdBy: a.userId,
    ...(termId ? { termId } : {}),
    ...(q.status ? { status: q.status as never } : {}),
  };
  if (a.role === "doctor" && q.include_subject === "true" && (await hasPermission(a.userId, a.role, "view_all_grades"))) {
    const assigned = await prisma.doctorAssignment.findMany({
      where: { doctorId: a.userId, ...(termId ? { termId } : {}) },
      select: { subjectId: true },
    });
    const subjectIds = assigned.map((d) => d.subjectId);
    if (subjectIds.length) {
      where = {
        ...(termId ? { termId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
        OR: [{ createdBy: a.userId }, { subjectId: { in: subjectIds } }],
      };
    }
  }
  const [total, rows] = await Promise.all([
    prisma.exam.count({ where }),
    prisma.exam.findMany({ where, orderBy: { startTime: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows.map(toSafeExam)));
});

// POST /exams — doctor→pending_approval, TA quiz→approved. Mix validated vs pool.
exams.post("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const body = z
    .object({
      subjectId: z.string(),
      termId: z.string().optional(),
      type: z.enum(["doctor_exam", "ta_quiz"]),
      title: z.string().trim().min(1).max(120),
      purpose: z.enum(["midterm", "quiz"]).default("quiz"),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      durationMinutes: z.number().int().positive(),
      notesEnabled: z.boolean().default(false),
      notesForDoctorEnabled: z.boolean().default(false),
      examToolsEnabled: z.boolean().default(true),
      maxReentries: z.number().int().min(0).max(20).default(3),
      resultsReleased: z.boolean().default(false),
      sebRequired: z.boolean().default(false),
      accessCode: z.string().trim().min(4).max(64).optional().or(z.literal("")),
      instructionsText: z.string().trim().max(10_000).nullable().optional(),
      instructionsRequireCompletion: z.boolean().default(false),
      difficultyMix: mixInput.optional(),
      // Manual blueprint: hand-picked question IDs in author order (sampling
      // bypassed). Either this or a non-empty difficultyMix is required.
      manualQuestionIds: z.array(z.string().uuid()).max(200).optional(),
      targetScope: z.enum(["subject", "sections", "student_list"]),
      targetSections: z.array(z.string()).max(config.lists.examTargetsMax).optional(),
      targetStudents: z.array(z.string()).max(config.lists.examTargetsMax).optional(),
      questionSource: z.enum(["own", "shared", "mine"]).optional(),
    })
    .parse(req.body);
  const manual = [...new Set(body.manualQuestionIds ?? [])];
  if (manual.length !== (body.manualQuestionIds ?? []).length) {
    return res.status(422).json({ error: "manualQuestionIds must be unique" });
  }
  const mix = body.difficultyMix ?? {};
  if (!manual.length) {
    if (!checkMix(mix)) return res.status(422).json({ error: "difficultyMix must be {easy?,medium?,hard?} non-negative ints" });
    if (Object.values(mix).every((n) => n <= 0)) return res.status(422).json({ error: "blueprint needs a mix or hand-picked questions" });
  } else if (body.difficultyMix && !checkMix(body.difficultyMix)) {
    // Stored alongside manual blueprints: validate the shape even though
    // sampling ignores it, so no malformed ghost mix persists.
    return res.status(422).json({ error: "difficultyMix must be {easy?,medium?,hard?} non-negative ints" });
  }
  const start = new Date(body.startTime);
  const end = new Date(body.endTime);
  const windowErr = checkWindow(start, end, body.durationMinutes);
  if (windowErr) return res.status(422).json({ error: windowErr });

  const termId = body.termId ?? (await currentTermId());
  if (!termId) return res.status(409).json({ error: "no current term" });
  const subject = await prisma.subject.findUnique({ where: { id: body.subjectId }, select: { id: true } });
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const source = body.questionSource ?? (a.role === "doctor" ? "own" : "shared");

  if (a.role === "doctor") {
    if (body.type !== "doctor_exam") return res.status(403).json({ error: "doctors create doctor_exam" });
    if (!(await hasPermission(a.userId, a.role, "create_exam"))) return res.status(403).json({ error: "forbidden", need: "create_exam" });
    if (!(await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: body.subjectId, termId } }))) {
      return res.status(403).json({ error: "not assigned to subject for this term" });
    }
  }
  if (a.role === "ta") {
    if (body.type !== "ta_quiz") return res.status(403).json({ error: "TAs create ta_quiz" });
    // TAs make quizzes only — midterms are a doctor+admin affair.
    if (body.purpose !== "quiz") return res.status(403).json({ error: "TAs create quizzes only" });
    if (!(await hasPermission(a.userId, a.role, "create_quiz"))) return res.status(403).json({ error: "forbidden", need: "create_quiz" });
    if (body.targetScope === "sections") {
      if (!body.targetSections?.length) return res.status(422).json({ error: "TA quiz needs targetSections" });
      // Every targeted section must be taught by this TA in this subject+term.
      const own = await prisma.section.count({
        where: { id: { in: body.targetSections }, taId: a.userId, subjectId: body.subjectId, termId },
      });
      if (own !== body.targetSections.length) return res.status(403).json({ error: "not your sections" });
    } else if (body.targetScope === "student_list") {
      if (!body.targetStudents?.length) return res.status(422).json({ error: "student_list needs targetStudents" });
      // TA must teach at least one section of this subject in the current term.
      const teaches = await prisma.section.count({
        where: { taId: a.userId, subjectId: body.subjectId, termId },
      });
      if (!teaches) return res.status(403).json({ error: "not assigned to any section of this subject for this term" });
    } else {
      return res.status(422).json({ error: "TA quiz must target sections or student_list" });
    }
  }
  // Sections scope needs real sections of THIS subject+term, for every role —
  // otherwise the exam is born unstartable (empty IN-list rejects everyone).
  if (body.targetScope === "sections") {
    if (!body.targetSections?.length) return res.status(422).json({ error: "sections scope needs targetSections" });
    const valid = await prisma.section.count({ where: { id: { in: body.targetSections }, subjectId: body.subjectId, termId } });
    if (valid !== body.targetSections.length) return res.status(422).json({ error: "targetSections must belong to this subject+term" });
  }
  const uniqueTargetStudents = [...new Set(body.targetStudents ?? [])];
  if (body.targetScope === "student_list" && !uniqueTargetStudents.length) {
    return res.status(422).json({ error: "student_list needs targetStudents" });
  }
  if (uniqueTargetStudents.length) {
    const tUsers = await prisma.user.findMany({
      where: { id: { in: uniqueTargetStudents } },
      select: { id: true, role: true, isActive: true },
    });
    const byId = new Map(tUsers.map((u) => [u.id, u]));
    const bad = uniqueTargetStudents.some((id) => {
      const u = byId.get(id);
      return !u || u.role !== "student" || !u.isActive;
    });
    if (bad) return res.status(422).json({ error: "targetStudents must exist as active student accounts" });
  }

  const pool = await poolWhere(a.userId, a.role, body.subjectId, source);
  if (!pool.ok) return res.status(422).json({ error: pool.error });
  if (!manual.length) {
    const short = mixShortfall(mix, await poolCounts(prisma, pool.where));
    if (short) return res.status(422).json({ error: "bank short for mix", ...short });
  } else {
    // Hand-picked IDs must all exist inside THIS subject and the creator's
    // own pool scope (no borrowing another bank's questions).
    const inScope = await prisma.question.count({ where: { id: { in: manual }, ...pool.where, subjectId: body.subjectId } });
    if (inScope !== manual.length) {
      return res.status(422).json({ error: "manual questions must exist in your bank for this subject" });
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    const exam = await tx.exam.create({
      data: {
        subjectId: body.subjectId,
        termId,
        type: body.type,
        createdBy: a.userId,
        // Quizzes go live immediately (no approval queue); midterms wait for
        // admin unless created by one. TAs can only reach this line as quiz.
        status: body.purpose === "quiz" || a.role === "admin" ? "approved" : "pending_approval",
        title: body.title,
        purpose: body.purpose,
        startTime: start,
        endTime: end,
        durationMinutes: body.durationMinutes,
        notesEnabled: body.notesEnabled,
        notesForDoctorEnabled: body.notesForDoctorEnabled,
        examToolsEnabled: body.examToolsEnabled,
        maxReentries: body.maxReentries,
        resultsReleased: body.resultsReleased,
        sebRequired: body.sebRequired,
        accessCodeHash:
          body.accessCode?.trim() && (body.purpose === "quiz" || a.role === "admin")
            ? hashEntryCode(body.accessCode.trim())
            : null,
        instructionsText: body.instructionsText?.trim() || null,
        instructionsRequireCompletion: body.instructionsRequireCompletion,
        difficultyMix: mix,
        manualQuestionIds: manual.length ? manual : Prisma.DbNull,
        questionSource: a.role === "ta" ? source : "own",
        targetScope: body.targetScope,
        targetSections: body.targetSections?.length ? { create: body.targetSections.map((sectionId) => ({ sectionId })) } : undefined,
        targetStudents: uniqueTargetStudents.length ? { create: uniqueTargetStudents.map((studentId) => ({ studentId })) } : undefined,
      },
    });
    return exam;
  });
  await audit(a.userId, "exam.create", "exam", row.id, { type: body.type, status: row.status });
  // Soft overlap warning (never blocks): exams sharing this subject+term and
  // window, so the author can spot double-bookings before students do.
  const warnings: string[] = [];
  try {
    const clashes = await overlappingExams(row.id, body.subjectId, termId, start, end, body.targetScope === "sections" ? (body.targetSections ?? []) : null);
    for (const c of clashes.slice(0, 3)) {
      warnings.push(`${c.title || "Untitled"} overlaps this window (${c.status})`);
    }
  } catch {
    // Warning is advisory only — creation already committed.
  }
  res.status(201).json({ ...toSafeExam(row), warnings });
});

// Windows overlap when a.start < b.end && b.start < a.end. Same subject+term,
// both approved; optionally restricted to shared sections. Powers the soft
// creation warning and the hard one-live-midterm approval rule.
export async function overlappingExams(
  excludeId: string,
  subjectId: string,
  termId: string,
  start: Date,
  end: Date,
  sectionIds: string[] | null,
  purpose?: "midterm" | "quiz",
): Promise<{ id: string; title: string; purpose: string; status: string }[]> {
  const rows = await prisma.exam.findMany({
    where: {
      id: { not: excludeId },
      subjectId,
      termId,
      status: "approved",
      ...(purpose ? { purpose } : {}),
      startTime: { lt: end },
      endTime: { gt: start },
    },
    select: { id: true, title: true, purpose: true, status: true, targetScope: true, targetSections: { select: { sectionId: true } } },
  });
  if (!sectionIds) return rows.map(({ targetScope, targetSections, ...r }) => r);
  const wanted = new Set(sectionIds);
  return rows
    .filter((r) => r.targetScope !== "sections" || r.targetSections.some((t) => wanted.has(t.sectionId)))
    .map(({ targetScope, targetSections, ...r }) => r);
}

async function ownExamOrAdmin(userId: string, role: string, id: string) {
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam) return { error: "not found" as const };
  if (role === "admin" || exam.createdBy === userId) return { exam };
  return { error: "not yours" as const };
}

// Creator-only + create-permission gate for single-exam reads/writes.
// Non-admin must be the creator AND hold their role's create permission
// (create_exam for doctors, create_quiz for TAs); revoked creators lose access.
async function creatorPermissionError(userId: string, role: string): Promise<{ error: string; need?: string } | null> {
  if (role === "admin") return null;
  if (role === "doctor") {
    if (!(await hasPermission(userId, role as never, "create_exam"))) return { error: "forbidden", need: "create_exam" };
    return null;
  }
  if (role === "ta") {
    if (!(await hasPermission(userId, role as never, "create_quiz"))) return { error: "forbidden", need: "create_quiz" };
    return null;
  }
  return { error: "forbidden" };
}

// GET /exams/live — "happening now" strip: the caller's exams whose window is
// currently open, each with live headcounts. Admin sees everything; staff see
// only their own creations. Powers the proctoring overview; read-only.
exams.get("/live", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - config.heartbeat.staleMs);
  const exams = await prisma.exam.findMany({
    where: {
      status: "approved",
      startTime: { lte: now },
      endTime: { gte: now },
      ...(a.role === "admin" ? {} : { createdBy: a.userId }),
    },
    select: {
      id: true,
      title: true,
      purpose: true,
      sebRequired: true,
      type: true,
      status: true,
      startTime: true,
      endTime: true,
      durationMinutes: true,
      resultsReleased: true,
      subject: { select: { code: true, name: true } },
    },
    orderBy: { endTime: "asc" },
  });
  const rows = await Promise.all(
    exams.map(async (e) => {
      const [inProgress, stale, submitted] = await Promise.all([
        prisma.studentExam.count({ where: { examId: e.id, status: "in_progress" } }),
        prisma.studentExam.count({ where: { examId: e.id, status: "in_progress", OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleCutoff } }] } }),
        prisma.studentExam.count({ where: { examId: e.id, status: { in: ["submitted", "auto_submitted"] } } }),
      ]);
      return { ...e, inProgress, stale, submitted };
    }),
  );
  res.json({ now, rows });
});

exams.get("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  // Same rule as the admin detail: presence only, never the hash.
  res.json(toSafeExam(own.exam));
});

// GET /exams/:id/blueprint — everything about one exam on a single page:
// settings, sampling blueprint or hand-picked questions (with answers —
// creator and admin only), live sittings counts. Students: 403.
exams.get("/:id/blueprint", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  const exam = own.exam;
  const manual = Array.isArray(exam.manualQuestionIds) ? (exam.manualQuestionIds as string[]) : [];
  let questions;
  if (manual.length) {
    const rows = await prisma.question.findMany({
      where: { id: { in: manual } },
      select: { id: true, text: true, questionType: true, difficulty: true, options: true, correctAnswer: true, grade: true, imageUrl: true, mediaUrl: true, mediaType: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    questions = manual.map((id) => byId.get(id)).filter((q) => q !== undefined);
  } else {
    const pool = await poolForExam(prisma, exam);
    questions = pool.ok
      ? await prisma.question.findMany({
          where: pool.where,
          select: { id: true, text: true, questionType: true, difficulty: true, options: true, correctAnswer: true, grade: true, imageUrl: true, mediaUrl: true, mediaType: true },
          take: 50,
          orderBy: { createdAt: "desc" },
        })
      : [];
  }
  const statusCounts = await prisma.studentExam.groupBy({
    by: ["status"],
    where: { examId: exam.id },
    _count: true,
  });
  const [targetSections, targetStudentRows] = await Promise.all([
    prisma.examTargetSection.findMany({
      where: { examId: exam.id },
      select: { section: { select: { id: true, name: true } } },
    }),
    prisma.examTargetStudent.findMany({
      where: { examId: exam.id },
      select: { student: { select: { id: true, name: true, username: true, email: true } } },
      orderBy: { student: { name: "asc" } },
      take: config.lists.examTargetsMax,
    }),
  ]);
  res.json({
    exam: toSafeExam(exam),
    mode: manual.length ? "manual" : "sample",
    questions,
    targets: {
      sections: targetSections.map((t) => t.section),
      studentCount: targetStudentRows.length,
      students: targetStudentRows.map((t) => t.student),
    },
    sittings: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
  });
});
exams.patch("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const body = z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      purpose: z.enum(["midterm", "quiz"]).optional(),
      notesEnabled: z.boolean().optional(),
      notesForDoctorEnabled: z.boolean().optional(),
      examToolsEnabled: z.boolean().optional(),
      maxReentries: z.number().int().min(0).max(20).optional(),
      resultsReleased: z.boolean().optional(),
      sebRequired: z.boolean().optional(),
      instructionsText: z.string().trim().max(10_000).nullable().optional(),
      instructionsRequireCompletion: z.boolean().optional(),
      startTime: z.string().datetime().optional(),
      endTime: z.string().datetime().optional(),
      durationMinutes: z.number().int().positive().optional(),
      difficultyMix: mixInput.optional(),
    })
    .parse(req.body);
  // NOTE: hand-picked blueprints lock at creation (sittings may reference
  // exact IDs) — PATCH covers window/duration/mix only, and mix patches on a
  // manual blueprint are 422 (ghost-mix guard: the mix would write but
  // sampling keeps serving manualQuestionIds).
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if ((a.role === "ta" || own.exam.type === "ta_quiz") && body.purpose === "midterm") {
    return res.status(403).json({ error: "TAs create quizzes only" });
  }
  if (own.exam.startTime.getTime() <= Date.now()) return res.status(409).json({ error: "locked", reason: "exam window has started" });
  const manual = Array.isArray(own.exam.manualQuestionIds) ? (own.exam.manualQuestionIds as string[]) : [];
  if (manual.length && body.difficultyMix) {
    return res.status(422).json({ error: "hand-picked blueprint locks difficultyMix: recreate the exam to switch modes" });
  }
  const start = body.startTime ? new Date(body.startTime) : own.exam.startTime;
  const end = body.endTime ? new Date(body.endTime) : own.exam.endTime;
  const windowErr = checkWindow(start, end, body.durationMinutes ?? own.exam.durationMinutes);
  if (windowErr) return res.status(422).json({ error: windowErr });
  if (body.difficultyMix && !checkMix(body.difficultyMix)) return res.status(422).json({ error: "bad difficultyMix" });
  // All-zero mixes are unstartable: same non-empty rule as create.
  if (body.difficultyMix && Object.values(body.difficultyMix).every((n) => n <= 0)) {
    return res.status(422).json({ error: "blueprint needs at least one question" });
  }
  if (body.difficultyMix) {
    // Same shortfall rule as create — no bypass via patch-then-grow.
    const pool = await poolForExam(prisma, own.exam);
    if (pool.ok) {
      const short = mixShortfall(body.difficultyMix, await poolCounts(prisma, pool.where));
      if (short) return res.status(422).json({ error: "bank short for mix", ...short });
    }
  }
  const needsReapproval =
    own.exam.status === "approved" &&
    a.role !== "admin" &&
    (own.exam.purpose === "midterm" || (body.purpose !== undefined && body.purpose !== own.exam.purpose));
  const data = {
    ...body,
    ...(body.instructionsText !== undefined ? { instructionsText: body.instructionsText?.trim() || null } : {}),
    ...(needsReapproval ? { status: "pending_approval" as const, approvedBy: null } : {}),
  };
  const row = await prisma.exam.update({
    where: { id: own.exam.id },
    // Approved midterms (or quizzes promoted to midterm) re-enter approval on edit.
    data,
  });
  await audit(a.userId, "exam.update", "exam", row.id, body);
  res.json(toSafeExam(row));
});

// POST /exams/:id/access-code — doctors & TAs may optionally set an entry code
// on their own quizzes (midterm entry codes stay admin-managed).
exams.post("/:id/access-code", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const { code } = z.object({ code: z.string().trim().min(4).max(64) }).parse(req.body);
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (a.role !== "admin" && own.exam.purpose !== "quiz") {
    return res.status(403).json({ error: "midterm entry codes are managed by administrators" });
  }
  await prisma.exam.update({ where: { id: own.exam.id }, data: { accessCodeHash: hashEntryCode(code) } });
  await audit(a.userId, "exam.access-code.set", "exam", own.exam.id);
  res.json({ ok: true, hasAccessCode: true });
});

exams.delete("/:id/access-code", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (a.role !== "admin" && own.exam.purpose !== "quiz") {
    return res.status(403).json({ error: "midterm entry codes are managed by administrators" });
  }
  await prisma.exam.update({ where: { id: own.exam.id }, data: { accessCodeHash: null } });
  await audit(a.userId, "exam.access-code.clear", "exam", own.exam.id);
  res.json({ ok: true, hasAccessCode: false });
});

// POST /exams/:id/instructions-media (multipart media=, optional mediaType=audio|video)
// Attaches a voice or video pre-exam briefing (max 25 MB, magic-byte verified).
exams.post("/:id/instructions-media", instructionMediaUpload.single("media"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (a.role !== "admin" && own.exam.endTime.getTime() <= Date.now()) {
    return res.status(409).json({ error: "locked", reason: "exam window has ended" });
  }
  if (!req.file) return res.status(400).json({ error: "media file required" });
  if (!mediaExtOk(req.file.originalname)) {
    return res.status(422).json({ error: "media must be mp3, wav, ogg, m4a, webm, mp4, or mov" });
  }
  const rawHint = String((req.body as Record<string, unknown> | undefined)?.mediaType ?? "").toLowerCase();
  const hint: "audio" | "video" | undefined =
    rawHint === "audio" || rawHint === "video"
      ? rawHint
      : req.file.mimetype.startsWith("audio/")
        ? "audio"
        : req.file.mimetype.startsWith("video/")
          ? "video"
          : undefined;
  const sniffed = sniffMedia(req.file.buffer, hint);
  if (!sniffed) {
    return res.status(422).json({ error: "file is not a valid audio or video recording" });
  }
  const oldKey = own.exam.instructionsMediaUrl ? storage.keyFromUrl(own.exam.instructionsMediaUrl) : null;
  const stored = await storage.put(`instructions/${own.exam.id}`, `briefing${sniffed.ext}`, req.file.buffer);
  const row = await prisma.exam.update({
    where: { id: own.exam.id },
    data: {
      instructionsMediaUrl: stored.url,
      instructionsMediaType: sniffed.kind,
    },
  });
  if (oldKey && oldKey !== stored.key) {
    await storage.delete(oldKey).catch(() => undefined);
  }
  await audit(a.userId, "exam.instructions-media", "exam", row.id, {
    mediaType: sniffed.kind,
    bytes: req.file.size,
  });
  res.json(toSafeExam(row));
});

exams.delete("/:id/instructions-media", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (a.role !== "admin" && own.exam.endTime.getTime() <= Date.now()) {
    return res.status(409).json({ error: "locked", reason: "exam window has ended" });
  }
  const oldKey = own.exam.instructionsMediaUrl ? storage.keyFromUrl(own.exam.instructionsMediaUrl) : null;
  const row = await prisma.exam.update({
    where: { id: own.exam.id },
    data: {
      instructionsMediaUrl: null,
      instructionsMediaType: null,
      instructionsRequireCompletion: false,
    },
  });
  if (oldKey) await storage.delete(oldKey).catch(() => undefined);
  await audit(a.userId, "exam.instructions-media-delete", "exam", row.id);
  res.json(toSafeExam(row));
});

exams.delete("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  if (own.exam.startTime.getTime() <= Date.now()) return res.status(409).json({ error: "locked", reason: "exam window has started" });
  // Staff exams are never born "draft" (pending_approval / approved quiz),
  // so draft|rejected-only would deadlock creators. Pre-start + unapproved or quiz wins.
  const deletable =
    own.exam.status === "draft" ||
    own.exam.status === "rejected" ||
    own.exam.status === "pending_approval" ||
    (own.exam.status === "approved" && (own.exam.type === "ta_quiz" || own.exam.purpose === "quiz"));
  if (!deletable) return res.status(409).json({ error: "cannot delete approved midterm exam" });
  const oldKey = own.exam.instructionsMediaUrl ? storage.keyFromUrl(own.exam.instructionsMediaUrl) : null;
  await prisma.exam.delete({ where: { id: own.exam.id } });
  if (oldKey) await storage.delete(oldKey).catch(() => undefined);
  await audit(a.userId, "exam.delete", "exam", own.exam.id);
  res.json({ ok: true });
});

// POST /exams/:id/release {released} — publish or hide grades for students.
// Works ANYTIME (before, during, after the window): releasing is a visibility
// switch, not an edit. Creator (or admin) only; staff see nothing extra.
exams.post("/:id/release", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const { released } = z.object({ released: z.boolean() }).parse(req.body);
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const permErr = await creatorPermissionError(a.userId, a.role);
  if (permErr) return res.status(403).json(permErr);
  const row = await prisma.exam.update({ where: { id: own.exam.id }, data: { resultsReleased: released } });
  await audit(a.userId, released ? "exam.release" : "exam.unrelease", "exam", row.id);
  res.json({ ok: true, resultsReleased: row.resultsReleased });
});

// GET /exams/:id/analytics — full exam intelligence for the author: hero
// aggregates, score distribution, per-question answer/skip/correct splits
// with option heatmaps and void impact, section comparison, submit timing,
// re-entry split, previous-term memory, and assigned-vs-absent counts.
// Same visibility as results (creators + permitted staff); correct answers
// and per-student rows never leave the server — only aggregates.
exams.get("/:id/analytics", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const exam = await prisma.exam.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, subjectId: true, termId: true, createdBy: true, type: true,
      startTime: true, endTime: true, durationMinutes: true, targetScope: true,
      targetSections: { select: { sectionId: true } },
      targetStudents: { select: { studentId: true } },
    },
  });
  if (!exam) return res.status(404).json({ error: "not found" });
  if (a.role !== "admin" && exam.createdBy !== a.userId) {
    if (a.role === "doctor") {
      const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: exam.subjectId, termId: exam.termId } });
      if (!assigned || !(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "not your subject" });
      }
    } else if (a.role === "ta") {
      return res.status(403).json({ error: "not your quiz" });
    }
  }
  if (a.role === "ta" && exam.createdBy === a.userId && !(await hasPermission(a.userId, a.role, "view_own_grades"))) {
    return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
  }

  const PASS = 60;
  const [sittings, memberships, sections] = await Promise.all([
    prisma.studentExam.findMany({
      where: { examId: exam.id },
      select: {
        id: true, studentId: true, status: true, startedAt: true, submittedAt: true,
        totalGrade: true, entryTokens: true,
        questions: {
          select: {
            questionId: true, selectedAnswer: true, gradeAwarded: true, isFlagged: true, creditAdjustmentReason: true,
            question: { select: { text: true, questionType: true, difficulty: true, grade: true, correctAnswer: true, options: true, imageUrl: true, mediaUrl: true, mediaType: true } },
          },
        },
      },
    }),
    prisma.sectionMembership.findMany({
      where: { section: { subjectId: exam.subjectId, termId: exam.termId } },
      select: { studentId: true, sectionId: true },
    }),
    prisma.section.findMany({
      where: { subjectId: exam.subjectId, termId: exam.termId },
      select: { id: true, name: true },
    }),
  ]);
  const graded = sittings.filter((s) => s.status === "submitted" || s.status === "auto_submitted");
  const sectionOf = new Map<string, string>();
  for (const m of memberships) if (!sectionOf.has(m.studentId)) sectionOf.set(m.studentId, m.sectionId);
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));

  // Precompute per-sitting total marks and pct once (O(S * Q) instead of repeated inner reductions).
  const sittingTotal = new Map<string, number>();
  const sittingPct = new Map<string, number | null>();
  for (const s of graded) {
    const total = s.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0);
    sittingTotal.set(s.id, total);
    sittingPct.set(s.id, total ? (Number(s.totalGrade ?? 0) / total) * 100 : null);
  }
  const pctOf = (s: (typeof graded)[number]): number | null => sittingPct.get(s.id) ?? null;

  // Assigned vs started vs absent.
  let assigned: number | null = null;
  if (exam.targetScope === "student_list") assigned = exam.targetStudents.length;
  else if (exam.targetScope === "sections") {
    const ids = exam.targetSections.map((t) => t.sectionId);
    assigned = await prisma.sectionMembership.count({ where: { sectionId: { in: ids } } });
  } else {
    assigned = await prisma.enrollment.count({ where: { subjectId: exam.subjectId, termId: exam.termId } });
  }
  const startedIds = new Set(sittings.map((s) => s.studentId));

  // Hero aggregates over graded sittings.
  const pcts = graded.map(pctOf).filter((p): p is number => p !== null);
  const avg = pcts.length ? pcts.reduce((x, y) => x + y, 0) / pcts.length : 0;
  const sorted = [...pcts].sort((x, y) => x - y);
  const percentile = (arr: number[], q: number): number => {
    if (!arr.length) return 0;
    const pos = (arr.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };
  const median = percentile(sorted, 0.5);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const stdDev = pcts.length
    ? Math.sqrt(pcts.reduce((acc, p) => acc + (p - avg) ** 2, 0) / pcts.length)
    : 0;
  const passCount = pcts.filter((p) => p >= PASS).length;
  const autoSubmitted = graded.filter((s) => s.status === "auto_submitted").length;
  const completionRate = assigned && assigned > 0 ? Math.round((graded.length / assigned) * 100) : null;

  // Pacing / time-vs-score buckets (% of allowed duration).
  const timeBucketDefs = [
    { key: "under_25", label: "< 25% time", min: 0, max: 0.25 },
    { key: "25_50", label: "25–50% time", min: 0.25, max: 0.5 },
    { key: "50_75", label: "50–75% time", min: 0.5, max: 0.75 },
    { key: "75_100", label: "75–100% time", min: 0.75, max: Infinity },
  ];
  const timeBucketPcts = timeBucketDefs.map(() => [] as number[]);
  let usedSum = 0, usedN = 0, rushSubmits = 0;
  for (const s of graded) {
    if (s.startedAt && s.submittedAt) {
      const mins = Math.max(0, (s.submittedAt.getTime() - s.startedAt.getTime()) / 60000);
      usedSum += mins; usedN++;
      const frac = exam.durationMinutes > 0 ? mins / exam.durationMinutes : 1;
      if (frac < 0.25) rushSubmits++;
      const p = pctOf(s);
      if (p !== null) {
        const bIdx = timeBucketDefs.findIndex((b) => frac >= b.min && frac < b.max);
        if (bIdx >= 0) timeBucketPcts[bIdx].push(p);
      }
    }
  }
  const timeBuckets = timeBucketDefs.map((b, i) => {
    const arr = timeBucketPcts[i];
    return {
      key: b.key,
      label: b.label,
      n: arr.length,
      avg: arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0,
      passRate: arr.length ? (arr.filter((p) => p >= PASS).length / arr.length) * 100 : 0,
    };
  });

  const distribution = Array.from({ length: 10 }, () => 0);
  for (const p of pcts) distribution[Math.min(9, Math.floor(p / 10))]++;

  // Submit curve: 12 buckets across the window.
  const submitCurve: { t: string; n: number }[] = [];
  {
    const span = exam.endTime.getTime() - exam.startTime.getTime();
    const buckets = Array.from({ length: 12 }, () => 0);
    for (const s of graded) {
      if (!s.submittedAt) continue;
      const idx = Math.min(11, Math.max(0, Math.floor(((s.submittedAt.getTime() - exam.startTime.getTime()) / span) * 12)));
      buckets[idx]++;
    }
    buckets.forEach((n, i) => {
      submitCurve.push({ t: new Date(exam.startTime.getTime() + (span * (i + 1)) / 12).toISOString(), n });
    });
  }

  // Re-entry split: one token vs several.
  const single = graded.filter((s) => s.entryTokens.length <= 1);
  const multi = graded.filter((s) => s.entryTokens.length > 1);
  const avgPct = (rows: typeof graded): number => {
    const ps = rows.map(pctOf).filter((p): p is number => p !== null);
    return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 0;
  };

  // Section comparison.
  const secAgg = new Map<string, number[]>();
  for (const s of graded) {
    const p = pctOf(s);
    if (p === null) continue;
    const sec = sectionOf.get(s.studentId);
    if (!sec) continue;
    const arr = secAgg.get(sec) ?? [];
    arr.push(p);
    secAgg.set(sec, arr);
  }
  const sectionRows = [...secAgg].map(([sectionId, ps]) => ({
    sectionId,
    name: sectionName.get(sectionId) ?? "?",
    n: ps.length,
    avg: ps.reduce((x, y) => x + y, 0) / ps.length,
    passRate: (ps.filter((p) => p >= PASS).length / ps.length) * 100,
  })).sort((x, y) => y.avg - x.avg);

  // Upper 27% / Lower 27% cohorts for psychometric Discrimination Index (D).
  const rankedSittings = graded
    .map((s) => ({ id: s.id, pct: pctOf(s) }))
    .filter((x): x is { id: string; pct: number } => x.pct !== null)
    .sort((a, b) => b.pct - a.pct);
  const cohortSize = rankedSittings.length >= 4 ? Math.max(1, Math.round(rankedSittings.length * 0.27)) : 0;
  const upperIds = new Set(cohortSize ? rankedSittings.slice(0, cohortSize).map((x) => x.id) : []);
  const lowerIds = new Set(cohortSize ? rankedSittings.slice(-cohortSize).map((x) => x.id) : []);

  // Per-question deep stats + option heatmap + discrimination + void impact in a single O(S * Q) pass.
  type QAgg = {
    text: string; type: string; difficulty: string; grade: number;
    correctAnswer: string;
    imageUrl: string | null; mediaUrl: string | null; mediaType: string | null;
    attempts: number; answered: number; correct: number; awardSum: number; flagged: number;
    voidPassDelta: number;
    upperAttempts: number; upperCorrect: number;
    lowerAttempts: number; lowerCorrect: number;
    labels: Set<string>;
    picks: Map<string, number>;
  };
  const byQ = new Map<string, QAgg>();
  let pendingManualGrades = 0;
  for (const s of graded) {
    const total = sittingTotal.get(s.id) ?? 0;
    const baseGrade = Number(s.totalGrade ?? 0);
    const alreadyPassed = (sittingPct.get(s.id) ?? 0) >= PASS;
    const isUpper = upperIds.has(s.id);
    const isLower = lowerIds.has(s.id);
    for (const r of s.questions) {
      const qType = r.question.questionType as QuestionTypeValue;
      let g = byQ.get(r.questionId);
      if (!g) {
        g = {
          text: r.question.text, type: r.question.questionType, difficulty: r.question.difficulty,
          grade: Number(r.question.grade ?? 0),
          correctAnswer: r.question.correctAnswer,
          imageUrl: r.question.imageUrl,
          mediaUrl: r.question.mediaUrl,
          mediaType: r.question.mediaType,
          attempts: 0, answered: 0, correct: 0, awardSum: 0, flagged: 0,
          voidPassDelta: 0,
          upperAttempts: 0, upperCorrect: 0,
          lowerAttempts: 0, lowerCorrect: 0,
          labels: new Set(),
          picks: new Map(),
        };
        if ((qType === "mcq" || qType === "true_false" || qType === "multi_select") && Array.isArray(r.question.options)) {
          for (const o of r.question.options) g.labels.add(String(o));
        }
        byQ.set(r.questionId, g);
      }
      g.attempts++;
      if (isUpper) g.upperAttempts++;
      if (isLower) g.lowerAttempts++;
      let gotRight = false;
      const awarded = Number(r.gradeAwarded ?? 0);
      if (r.selectedAnswer !== null && r.selectedAnswer !== "") {
        g.answered++;
        if (qType === "mcq" || qType === "true_false") {
          g.picks.set(r.selectedAnswer, (g.picks.get(r.selectedAnswer) ?? 0) + 1);
          g.labels.add(r.selectedAnswer);
          if (r.selectedAnswer === r.question.correctAnswer) {
            g.correct++;
            gotRight = true;
          }
        } else if (qType === "multi_select") {
          const pickedArr = safeJsonParse<string[]>(r.selectedAnswer) ?? [];
          for (const p of pickedArr) {
            g.picks.set(p, (g.picks.get(p) ?? 0) + 1);
            g.labels.add(p);
          }
          const scored = scoreQuestionAnswer(qType, r.selectedAnswer, r.question.correctAnswer, r.question.options, g.grade);
          if (scored.isFullCredit || (g.grade > 0 && awarded >= g.grade * 0.99)) {
            g.correct++;
            gotRight = true;
          }
        } else if (qType === "essay") {
          if (awarded === 0 && !r.creditAdjustmentReason) pendingManualGrades++;
          if (g.grade > 0 && awarded >= g.grade * 0.6) {
            g.correct++;
            gotRight = true;
          }
        } else {
          // short_answer, matching, ordering
          const scored = scoreQuestionAnswer(qType, r.selectedAnswer, r.question.correctAnswer, r.question.options, g.grade);
          if (scored.isFullCredit || (g.grade > 0 && awarded >= g.grade * 0.99)) {
            g.correct++;
            gotRight = true;
          }
        }
      }
      if (gotRight && isUpper) g.upperCorrect++;
      if (gotRight && isLower) g.lowerCorrect++;
      g.awardSum += awarded;
      if (r.isFlagged) g.flagged++;
      // Void impact: count ONLY students who were actually sampled this question.
      if (!alreadyPassed && total > 0 && g.grade > 0) {
        const lifted = ((baseGrade - awarded + g.grade) / total) * 100;
        if (lifted >= PASS) g.voidPassDelta++;
      }
    }
  }

  const questions = [...byQ].map(([questionId, g]) => {
    const skipped = g.attempts - g.answered;
    const wrong = g.answered - g.correct;
    const missed = g.attempts - g.correct;
    const pctCorrect = g.attempts ? Math.round((g.correct / g.attempts) * 100) : 0;
    const pctWrong = g.attempts ? Math.round((missed / g.attempts) * 100) : 0;
    const wrongOfAnsweredPct = g.answered ? Math.round((wrong / g.answered) * 100) : 0;
    const multiCorrectSet = g.type === "multi_select" ? new Set(safeJsonParse<string[]>(g.correctAnswer) ?? []) : null;
    const options = [...g.labels].map((label) => {
      const picks = g.picks.get(label) ?? 0;
      return {
        label,
        picks,
        pct: g.attempts ? Math.round((picks / g.attempts) * 100) : 0,
        isCorrect: multiCorrectSet ? multiCorrectSet.has(label) : label === g.correctAnswer,
      };
    });
    const wrongOpts = options.filter((o) => !o.isCorrect && o.picks > 0).sort((a, b) => b.picks - a.picks);
    const mostCommonWrongOption = wrongOpts.length
      ? { label: wrongOpts[0].label, picks: wrongOpts[0].picks, pct: wrongOpts[0].pct }
      : null;
    const distractorBeatKey = Boolean(mostCommonWrongOption && mostCommonWrongOption.picks > g.correct);
    const discriminationIndex =
      g.upperAttempts > 0 && g.lowerAttempts > 0
        ? Number(((g.upperCorrect / g.upperAttempts) - (g.lowerCorrect / g.lowerAttempts)).toFixed(2))
        : null;

    const flagReasons: string[] = [];
    if (pctWrong >= 60) flagReasons.push("critical_wrong_rate");
    else if (pctWrong >= 45) flagReasons.push("high_wrong_rate");
    if (distractorBeatKey) flagReasons.push("distractor_beat_key");
    if (discriminationIndex !== null && discriminationIndex < 0) flagReasons.push("negative_discrimination");
    else if (discriminationIndex !== null && discriminationIndex < 0.15) flagReasons.push("low_discrimination");
    if (g.attempts > 0 && skipped / g.attempts >= 0.25) flagReasons.push("high_skip_rate");
    if (g.attempts > 0 && g.flagged / g.attempts >= 0.25) flagReasons.push("frequently_flagged");

    const alertLevel: "critical" | "warning" | "ok" =
      pctWrong >= 60 || distractorBeatKey || (discriminationIndex !== null && discriminationIndex < 0)
        ? "critical"
        : flagReasons.length > 0
          ? "warning"
          : "ok";

    return {
      questionId,
      text: g.text,
      type: g.type,
      difficulty: g.difficulty,
      grade: g.grade,
      imageUrl: g.imageUrl,
      mediaUrl: g.mediaUrl,
      mediaType: g.mediaType,
      attempts: g.attempts,
      answered: g.answered,
      skipped,
      correct: g.correct,
      wrong,
      pctCorrect,
      pctWrong,
      wrongOfAnsweredPct,
      answerRate: g.attempts ? Math.round((g.answered / g.attempts) * 100) : 0,
      avgAward: g.attempts ? Number((g.awardSum / g.attempts).toFixed(2)) : 0,
      flagged: g.flagged,
      voidPassDelta: g.voidPassDelta,
      discriminationIndex,
      mostCommonWrongOption,
      distractorBeatKey,
      alertLevel,
      flagReasons,
      options,
    };
  }).sort((x, y) => x.pctCorrect - y.pctCorrect || y.wrong - x.wrong);

  // Difficulty & question-type breakdowns.
  const difficultyBreakdown = (["easy", "medium", "hard"] as const).map((diff) => {
    const qs = questions.filter((q) => q.difficulty === diff);
    const attempts = qs.reduce((s, q) => s + q.attempts, 0);
    const correct = qs.reduce((s, q) => s + q.correct, 0);
    const wrong = qs.reduce((s, q) => s + (q.attempts - q.correct), 0);
    return {
      difficulty: diff,
      questionCount: qs.length,
      attempts,
      correct,
      wrong,
      pctCorrect: attempts ? Math.round((correct / attempts) * 100) : 0,
    };
  }).filter((d) => d.questionCount > 0);

  const questionTypeBreakdown = QUESTION_TYPES.map((qt) => {
    const qs = questions.filter((q) => q.type === qt);
    const attempts = qs.reduce((s, q) => s + q.attempts, 0);
    const correct = qs.reduce((s, q) => s + q.correct, 0);
    return {
      type: qt,
      questionCount: qs.length,
      attempts,
      correct,
      pctCorrect: attempts ? Math.round((correct / attempts) * 100) : 0,
    };
  }).filter((d) => d.questionCount > 0);

  const flaggedSummary = {
    totalQuestions: questions.length,
    criticalCount: questions.filter((q) => q.alertLevel === "critical").length,
    warningCount: questions.filter((q) => q.alertLevel === "warning").length,
    highMissCount: questions.filter((q) => q.pctWrong >= 50).length,
    lowDiscriminationCount: questions.filter((q) => q.discriminationIndex !== null && q.discriminationIndex < 0.15).length,
    distractorBeatKeyCount: questions.filter((q) => q.distractorBeatKey).length,
  };

  // Previous-term memory: same subject, latest other term with submissions.
  let prevTerm: { termName: string; avg: number; passRate: number; submitted: number } | null = null;
  {
    const terms = await prisma.term.findMany({
      where: { id: { not: exam.termId } },
      select: { id: true, name: true, endsOn: true },
      orderBy: { endsOn: "desc" },
    });
    for (const t of terms) {
      const prev = await prisma.studentExam.findMany({
        where: { exam: { subjectId: exam.subjectId, termId: t.id }, status: { in: ["submitted", "auto_submitted"] } },
        select: {
          totalGrade: true,
          questions: { select: { gradeAwarded: true, question: { select: { grade: true } } } },
        },
        take: 5000,
      });
      if (!prev.length) continue;
      const ps: number[] = [];
      for (const s of prev) {
        const total = s.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0);
        if (total) ps.push((Number(s.totalGrade ?? 0) / total) * 100);
      }
      if (!ps.length) continue;
      prevTerm = {
        termName: t.name,
        avg: ps.reduce((x, y) => x + y, 0) / ps.length,
        passRate: (ps.filter((p) => p >= PASS).length / ps.length) * 100,
        submitted: prev.length,
      };
      break;
    }
  }

  await audit(a.userId, "exam.analytics", "exam", exam.id, { submitted: graded.length });
  res.json({
    examId: exam.id,
    durationMinutes: exam.durationMinutes,
    assigned,
    started: startedIds.size,
    absent: assigned === null ? null : Math.max(0, assigned - startedIds.size),
    submitted: graded.length,
    inProgress: sittings.filter((s) => s.status === "in_progress").length,
    completionRate,
    avg, median, q1, q3, stdDev,
    high: sorted.length ? sorted[sorted.length - 1] : 0,
    low: sorted.length ? sorted[0] : 0,
    passRate: pcts.length ? (passCount / pcts.length) * 100 : 0,
    passCount,
    autoSubmitted,
    rushSubmits,
    avgMinutesUsed: usedN ? usedSum / usedN : 0,
    distribution,
    submitCurve,
    timeBuckets,
    difficultyBreakdown,
    questionTypeBreakdown,
    flaggedSummary,
    pendingManualGrades,
    reentry: {
      single: { n: single.length, avg: avgPct(single) },
      multi: { n: multi.length, avg: avgPct(multi) },
    },
    sections: sectionRows,
    questions,
    prevTerm,
  });
});

// GET /exams/:id/results — doctor: all groups w/ TA names; TA: own groups only.
// Bulk grade reads are audited (who saw whose grades, when).
exams.get("/:id/results", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const q = z.object({ limit: z.coerce.number().int().min(1).max(config.lists.resultsMax).default(500) }).parse(req.query);
  const exam = await prisma.exam.findUnique({ where: { id: String(req.params.id) }, select: { id: true, subjectId: true, termId: true, targetScope: true, createdBy: true } });
  if (!exam) return res.status(404).json({ error: "not found" });
  // Creators always see their own. Otherwise: term-scoped assignment AND the
  // view permission — a prior-term assignment alone must not open this term.
  if (a.role !== "admin" && exam.createdBy !== a.userId) {
    if (a.role === "doctor") {
      const assigned = await prisma.doctorAssignment.count({ where: { doctorId: a.userId, subjectId: exam.subjectId, termId: exam.termId } });
      if (!assigned || !(await hasPermission(a.userId, a.role, "view_all_grades"))) {
        return res.status(403).json({ error: "not your subject" });
      }
    } else if (a.role === "ta") {
      return res.status(403).json({ error: "not your quiz" });
    }
  }
  if (a.role === "ta" && exam.createdBy === a.userId && !(await hasPermission(a.userId, a.role, "view_own_grades"))) {
    return res.status(403).json({ error: "forbidden", need: "view_own_grades" });
  }

  if (exam.targetScope === "student_list") {
    const [targets, sittings] = await Promise.all([
      prisma.examTargetStudent.findMany({
        where: { examId: exam.id },
        select: { student: { select: { id: true, username: true, name: true, email: true, academicYear: true } } },
        orderBy: { student: { name: "asc" } },
        take: q.limit,
      }),
      prisma.studentExam.findMany({
        where: { examId: exam.id },
        select: {
          studentId: true,
          status: true,
          totalGrade: true,
          submittedAt: true,
          notesForDoctor: true,
          student: { select: { id: true, username: true, name: true, email: true, academicYear: true } },
          questions: { select: { question: { select: { grade: true } } } },
        },
      }),
    ]);
    const studentMap = new Map<string, { id: string; username: string | null; name: string; email?: string; academicYear?: number | null }>();
    for (const t of targets) studentMap.set(t.student.id, t.student);
    const sittingById = new Map(
      sittings.map((g) => {
        studentMap.set(g.student.id, g.student);
        return [
          g.studentId,
          {
            studentId: g.studentId,
            status: g.status,
            totalGrade: g.totalGrade,
            submittedAt: g.submittedAt,
            notesForDoctor: g.notesForDoctor,
            totalMarks: g.questions.reduce((sum, qu) => sum + Number(qu.question.grade ?? 0), 0),
          },
        ];
      }),
    );
    const students = [...studentMap.values()].sort((x, y) => x.name.localeCompare(y.name));
    const groups = students.length
      ? [
          {
            sectionId: "student_list",
            sectionName: "Targeted Student List",
            taName: "—",
            taUsername: null,
            total: students.length,
            rows: students.map((st) => ({ ...st, exam: sittingById.get(st.id) ?? null })),
          },
        ]
      : [];
    await audit(a.userId, "results.view", "exam", exam.id, { groups: groups.length, limit: q.limit });
    return res.json({ examId: exam.id, groups });
  }

  const sections = await prisma.section.findMany({
    // Targeted exams show only targeted sections — never the whole subject.
    where: {
      subjectId: exam.subjectId,
      termId: exam.termId,
      ...(exam.targetScope === "sections"
        ? { id: { in: (await prisma.examTargetSection.findMany({ where: { examId: exam.id }, select: { sectionId: true } })).map((t) => t.sectionId) } }
        : {}),
      ...(a.role === "ta" ? { taId: a.userId } : {}),
    },
    select: { id: true, name: true, ta: { select: { name: true, username: true } } },
    orderBy: { name: "asc" },
  });
  const sectorsSeen = new Set<string>();
  const groups = [];
  for (const s of sections) {
    // Full roster per section (default 500, not page 20): a 40-seat lab must
    // never silently clip students 21+. Clients may pass ?limit= for huge halls.
    const [total, memberships] = await Promise.all([
      prisma.sectionMembership.count({ where: { sectionId: s.id } }),
      prisma.sectionMembership.findMany({
        where: { sectionId: s.id },
        select: { student: { select: { id: true, username: true, name: true, email: true, academicYear: true } } },
        orderBy: { student: { name: "asc" } },
        take: q.limit,
      }),
    ]);
    const ids = memberships.map((m) => m.student.id);
    for (const id of ids) sectorsSeen.add(id);
    const grades = await prisma.studentExam.findMany({
      where: { examId: exam.id, studentId: { in: ids } },
      select: { studentId: true, status: true, totalGrade: true, submittedAt: true, notesForDoctor: true, questions: { select: { question: { select: { grade: true } } } } },
    });
    const byId = new Map(grades.map((g) => [g.studentId, { ...g, totalMarks: g.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0), questions: undefined }]));
    groups.push({ sectionId: s.id, sectionName: s.name, taName: s.ta.name, taUsername: s.ta.username, total, rows: memberships.map((m) => ({ ...m.student, exam: byId.get(m.student.id) ?? null })) });
  }
  if (a.role !== "ta" && exam.targetScope !== "sections") {
    const [extraSittings, extraEnrolled] = await Promise.all([
      prisma.studentExam.findMany({
        where: { examId: exam.id, ...(sectorsSeen.size > 0 ? { studentId: { notIn: [...sectorsSeen] } } : {}) },
        select: { studentId: true, status: true, totalGrade: true, submittedAt: true, notesForDoctor: true, student: { select: { id: true, username: true, name: true, email: true, academicYear: true } }, questions: { select: { question: { select: { grade: true } } } } },
      }),
      prisma.enrollment.findMany({
        where: { subjectId: exam.subjectId, termId: exam.termId, ...(sectorsSeen.size > 0 ? { studentId: { notIn: [...sectorsSeen] } } : {}) },
        select: { student: { select: { id: true, username: true, name: true, email: true, academicYear: true } } },
        take: q.limit,
      }),
    ]);
    const extraStudentMap = new Map<string, { id: string; username: string | null; name: string; email?: string; academicYear?: number | null }>();
    for (const e of extraEnrolled) extraStudentMap.set(e.student.id, e.student);
    const sittingById = new Map(
      extraSittings.map((g) => {
        extraStudentMap.set(g.student.id, g.student);
        return [
          g.studentId,
          {
            studentId: g.studentId,
            status: g.status,
            totalGrade: g.totalGrade,
            submittedAt: g.submittedAt,
            notesForDoctor: g.notesForDoctor,
            totalMarks: g.questions.reduce((sum, q) => sum + Number(q.question.grade ?? 0), 0),
          },
        ];
      }),
    );
    if (extraStudentMap.size > 0) {
      const extraStudents = [...extraStudentMap.values()].sort((x, y) => x.name.localeCompare(y.name));
      groups.push({
        sectionId: "unassigned",
        sectionName: "Direct Enrollment (No Section)",
        taName: "—",
        taUsername: null,
        total: extraStudents.length,
        rows: extraStudents.map((st) => ({ ...st, exam: sittingById.get(st.id) ?? null })),
      });
    }
  }
  await audit(a.userId, "results.view", "exam", exam.id, { groups: groups.length, limit: q.limit });
  res.json({ examId: exam.id, groups });
});

// GET /exams/:id/manual-grading — lists submitted essay answers awaiting or
// completed manual grading for the exam creator or admin.
exams.get("/:id/manual-grading", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });

  const rows = await prisma.studentExamQuestion.findMany({
    where: {
      studentExam: { examId: own.exam.id, status: { in: ["submitted", "auto_submitted"] } },
      question: { questionType: "essay" },
    },
    select: {
      id: true,
      questionId: true,
      selectedAnswer: true,
      gradeAwarded: true,
      creditAdjustmentReason: true,
      studentExam: {
        select: {
          id: true,
          submittedAt: true,
          totalGrade: true,
          student: { select: { id: true, name: true, username: true } },
        },
      },
      question: {
        select: {
          id: true,
          text: true,
          grade: true,
          correctAnswer: true,
          mediaUrl: true,
          mediaType: true,
        },
      },
    },
    orderBy: [{ studentExam: { submittedAt: "desc" } }],
    take: 500,
  });

  res.json({
    examId: own.exam.id,
    items: rows.map((r) => ({
      id: r.id,
      questionId: r.questionId,
      studentExamId: r.studentExam.id,
      student: r.studentExam.student,
      submittedAt: r.studentExam.submittedAt,
      questionText: r.question.text,
      questionMediaUrl: r.question.mediaUrl,
      questionMediaType: r.question.mediaType,
      modelAnswer: r.question.correctAnswer,
      maxGrade: Number(r.question.grade),
      answer: r.selectedAnswer ?? "",
      gradeAwarded: Number(r.gradeAwarded ?? 0),
      feedback: r.creditAdjustmentReason ?? "",
      isGraded: Number(r.gradeAwarded ?? 0) > 0 || Boolean(r.creditAdjustmentReason),
    })),
  });
});

// PATCH /exams/:id/manual-grading/:seqId — grade a student's essay response and
// atomically recompute the student's total exam grade.
exams.patch("/:id/manual-grading/:seqId", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const own = await ownExamOrAdmin(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });

  const body = z
    .object({
      gradeAwarded: z.number().min(0),
      feedback: z.string().trim().max(1000).optional(),
    })
    .parse(req.body);

  const seq = await prisma.studentExamQuestion.findUnique({
    where: { id: String(req.params.seqId) },
    include: {
      studentExam: { select: { id: true, examId: true, status: true } },
      question: { select: { grade: true, questionType: true } },
    },
  });
  if (!seq || seq.studentExam.examId !== own.exam.id) {
    return res.status(404).json({ error: "submission answer not found" });
  }
  const maxGrade = Number(seq.question.grade);
  if (body.gradeAwarded > maxGrade) {
    return res.status(422).json({ error: `gradeAwarded cannot exceed question max grade (${maxGrade})` });
  }

  const updatedTotal = await prisma.$transaction(async (tx) => {
    await tx.studentExamQuestion.update({
      where: { id: seq.id },
      data: {
        gradeAwarded: new Prisma.Decimal(body.gradeAwarded.toFixed(2)),
        creditAdjustmentReason: body.feedback?.trim() || "Manually graded",
      },
    });
    const all = await tx.studentExamQuestion.findMany({
      where: { studentExamId: seq.studentExam.id },
      select: { gradeAwarded: true },
    });
    let sum = new Prisma.Decimal(0);
    for (const q of all) sum = sum.plus(new Prisma.Decimal(Number(q.gradeAwarded ?? 0).toFixed(2)));
    await tx.studentExam.update({
      where: { id: seq.studentExam.id },
      data: { totalGrade: sum },
    });
    return Number(sum);
  });

  await audit(a.userId, "exam.manual-grade", "student_exam_question", seq.id, {
    examId: own.exam.id,
    gradeAwarded: body.gradeAwarded,
  });
  res.json({ ok: true, gradeAwarded: body.gradeAwarded, totalGrade: updatedTotal });
});
