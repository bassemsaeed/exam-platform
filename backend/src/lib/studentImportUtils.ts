import crypto from "node:crypto";
import * as XLSX from "xlsx";

export const MAX_STUDENT_IMPORT_ROWS = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

export const STUDENT_HEADER_ALIASES: Record<
  string,
  "student_id" | "full_name" | "email" | "year" | "section" | "password"
> = {
  student_id: "student_id",
  studentid: "student_id",
  username: "student_id",
  user_name: "student_id",
  id: "student_id",
  code: "student_id",
  student_code: "student_id",
  "student id": "student_id",
  "الرقم الجامعي": "student_id",
  "رقم الطالب": "student_id",
  "اسم المستخدم": "student_id",
  "الكود": "student_id",
  full_name: "full_name",
  fullname: "full_name",
  name: "full_name",
  student_name: "full_name",
  "full name": "full_name",
  "student name": "full_name",
  "الاسم": "full_name",
  "اسم الطالب": "full_name",
  "الاسم الكامل": "full_name",
  email: "email",
  "e-mail": "email",
  mail: "email",
  "البريد": "email",
  "البريد الإلكتروني": "email",
  "الايميل": "email",
  year: "year",
  academic_year: "year",
  "academic year": "year",
  level: "year",
  grade_level: "year",
  "الفرقة": "year",
  "السنة": "year",
  "السنة الدراسية": "year",
  section: "section",
  section_name: "section",
  "section name": "section",
  group: "section",
  lab: "section",
  "الشعبة": "section",
  "السكشن": "section",
  "المجموعة": "section",
  password: "password",
  pass: "password",
  initial_password: "password",
  "initial password": "password",
  "كلمة المرور": "password",
  "الباسورد": "password",
};

export interface StudentSheetRow {
  line: number;
  username: string;
  fullName: string;
  email?: string;
  academicYear?: number;
  sectionName?: string;
  password?: string;
}

/**
 * Neutralizes spreadsheet formula injection (=, +, -, @, tab, CR) so exported
 * Excel/CSV cells can never trigger formula execution when opened by staff.
 */
export function safeExcelCell(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function generateReadablePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(8);
  let body = "";
  for (let i = 0; i < 8; i++) body += chars[bytes[i] % chars.length];
  return `O6u-${body}`;
}

export function parseStudentWorkbook(buf: Buffer): {
  rows: StudentSheetRow[];
  errors: { line: number; reason: string }[];
} {
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
  if (raw.length > MAX_STUDENT_IMPORT_ROWS) {
    throw new Error(`spreadsheet exceeds maximum of ${MAX_STUDENT_IMPORT_ROWS} rows`);
  }

  const rows: StudentSheetRow[] = [];
  const errors: { line: number; reason: string }[] = [];
  const str = (v: unknown) => String(v ?? "").trim();

  raw.forEach((orig, idx) => {
    const line = idx + 2;
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) {
      const cleanKey = k.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
      const canonical =
        STUDENT_HEADER_ALIASES[cleanKey] ??
        STUDENT_HEADER_ALIASES[cleanKey.replace(/\s+/g, "_")];
      if (canonical && !mapped[canonical]) {
        mapped[canonical] = str(v);
      }
    }
    if (!Object.values(mapped).some(Boolean)) return;

    const username = (mapped.student_id ?? "").toLowerCase();
    const emailRaw = (mapped.email ?? "").toLowerCase();
    const fullName = mapped.full_name ?? "";
    const password = mapped.password ?? "";
    const sectionName = mapped.section ?? "";
    const yearRaw = mapped.year ?? "";

    if (!username && !emailRaw) {
      errors.push({ line, reason: "missing student_id / username (or email)" });
      return;
    }
    if (username) {
      if (username.length > 64) {
        errors.push({ line, reason: "student_id exceeds 64 characters" });
        return;
      }
      if (!USERNAME_RE.test(username)) {
        errors.push({ line, reason: `invalid student_id characters: ${username}` });
        return;
      }
    }
    if (emailRaw) {
      if (emailRaw.length > 254 || !EMAIL_RE.test(emailRaw)) {
        errors.push({ line, reason: `invalid email format: ${emailRaw}` });
        return;
      }
    }
    if (fullName.length > 120) {
      errors.push({ line, reason: "full_name exceeds 120 characters" });
      return;
    }
    if (sectionName.length > 120) {
      errors.push({ line, reason: "section name exceeds 120 characters" });
      return;
    }
    let academicYear: number | undefined;
    if (yearRaw) {
      const y = Number(yearRaw);
      if (!Number.isInteger(y) || y < 1 || y > 7) {
        errors.push({ line, reason: `invalid academic year (expected 1..7): ${yearRaw}` });
        return;
      }
      academicYear = y;
    }
    rows.push({
      line,
      username,
      fullName,
      email: emailRaw || undefined,
      academicYear,
      sectionName: sectionName || undefined,
      password: password || undefined,
    });
  });

  return { rows, errors };
}
