import { Router, type Router as RouterType } from "express";
import multer from "multer";
import unzipper from "unzipper";
import * as XLSX from "xlsx";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import type { Role } from "../generated/prisma/browser.js";
import { storage, sniffImage } from "../lib/storage.js";
import { envelope, page, pageQuery } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadMaxBytes } });
// Raster-only image whitelist: SVG is XML + script (stored XSS served from
// /uploads in-app origin). Extension checked server-side — the client MIME is
// untrusted. Zip-imported images go through the same gate at commit time.
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

function imageExtOk(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && (IMAGE_EXTS as readonly string[]).includes(filename.slice(dot).toLowerCase());
}
const TYPES = ["mcq", "true_false"] as const;
const DIFFS = ["easy", "medium", "hard"] as const;

const questionBody = z.object({
  subjectId: z.string(),
  questionType: z.enum(TYPES),
  text: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(6),
  correctAnswer: z.string().min(1),
  grade: z.number().positive(),
  difficulty: z.enum(DIFFS),
});

function checkOptions(t: (typeof TYPES)[number], options: string[], correct: string): string | null {
  if (!options.includes(correct)) return "correctAnswer must be one of options";
  if (t === "true_false") {
    const low = options.map((o) => o.toLowerCase());
    if (low.length !== 2 || !low.includes("true") || !low.includes("false")) {
      return "true_false requires options [True, False]";
    }
  }
  return null;
}

async function doctorOwns(userId: string, subjectId: string): Promise<boolean> {
  return (await prisma.doctorAssignment.count({ where: { doctorId: userId, subjectId } })) > 0;
}

async function taTeaches(userId: string, subjectId: string): Promise<boolean> {
  return (await prisma.section.count({ where: { taId: userId, subjectId } })) > 0;
}

async function mayBank(userId: string, role: Role, subjectId: string): Promise<boolean> {
  if (role === "admin") return true;
  if (role === "doctor") return doctorOwns(userId, subjectId);
  if (role === "ta") return taTeaches(userId, subjectId);
  return false;
}

export const questionBank: RouterType = Router();
// Overrides enforce here (not just display): revoking manage_question_bank
// locks the bank even though role scoping below stays as second layer.
questionBank.use(requireAuth, requirePermission("manage_question_bank"));

// GET /question-bank?subject_id*&owner_type&mine&difficulty — scoped by role.
questionBank.get("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const q = pageQuery
    .extend({ subject_id: z.string(), owner_type: z.enum(["doctor", "ta_shared"]).optional(), mine: z.enum(["true", "false"]).optional().transform((v) => v === "true"), difficulty: z.enum(DIFFS).optional(), search: z.string().max(120).optional() })
    .parse(req.query);
  if (!(await mayBank(a.userId, a.role, q.subject_id))) return res.status(403).json({ error: "not your subject" });
  // Banks are separate: doctors see private, TAs see shared (never each other's).
  const ownerType = q.owner_type ?? (a.role === "doctor" ? "doctor" : a.role === "ta" ? "ta_shared" : undefined);
  if (a.role === "doctor" && ownerType !== "doctor") return res.status(403).json({ error: "doctor bank only" });
  if (a.role === "ta" && ownerType !== "ta_shared") return res.status(403).json({ error: "shared bank only" });
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  // Banks are separate AND private: doctors always see only their own rows,
  // TAs see the shared bank (optionally only their own via mine).
  const where = {
    subjectId: q.subject_id,
    ...(ownerType ? { ownerType } : {}),
    ...(a.role === "doctor" ? { doctorId: a.userId } : q.mine ? { addedByTaId: a.userId } : {}),
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    ...(q.search?.trim() ? { text: { contains: q.search.trim(), mode: "insensitive" as const } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.question.count({ where }),
    prisma.question.findMany({ where, orderBy: { createdAt: "desc" }, ...page(q) }),
  ]);
  res.json(envelope(total, q, rows));
});

// GET /question-bank/counts?subject_id*&mine — tier counts for mix validation UI.
questionBank.get("/counts", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const q = z.object({ subject_id: z.string(), mine: z.enum(["true", "false"]).optional().transform((v) => v === "true") }).parse(req.query);
  if (!(await mayBank(a.userId, a.role, q.subject_id))) return res.status(403).json({ error: "not your subject" });
  const owner = a.role === "doctor" ? { ownerType: "doctor" as const, doctorId: a.userId } : { ownerType: "ta_shared" as const, ...(q.mine ? { addedByTaId: a.userId } : {}) };
  const rows = await prisma.question.groupBy({ by: ["difficulty"], where: { subjectId: q.subject_id, ...owner }, _count: true });
  const out: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  for (const r of rows) out[r.difficulty] = r._count;
  res.json(out);
});

questionBank.post("/", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const body = questionBody.extend({ ownerType: z.enum(["doctor", "ta_shared"]).optional(), owner: z.string().optional() }).parse(req.body);
  // Admins don't own banks: attribute to an explicit scoped owner (same rule
  // as the import path) instead of minting ta_shared orphans.
  let ownerType: "doctor" | "ta_shared";
  let ownerId: string;
  if (a.role === "admin") {
    if (!body.ownerType || !body.owner) return res.status(422).json({ error: "admin rows need ownerType + owner username" });
    const owner = await prisma.user.findUnique({ where: { username: body.owner.toLowerCase() }, select: { id: true, role: true } });
    if (!owner) return res.status(404).json({ error: "owner not found" });
    if ((body.ownerType === "doctor" && owner.role !== "doctor") || (body.ownerType === "ta_shared" && owner.role !== "ta")) {
      return res.status(422).json({ error: "owner role mismatch" });
    }
    if (!(await mayBank(owner.id, owner.role, body.subjectId))) return res.status(403).json({ error: "owner not scoped to subject" });
    ownerType = body.ownerType;
    ownerId = owner.id;
  } else {
    if (a.role === "student") return res.status(403).json({ error: "forbidden" });
    if (!(await mayBank(a.userId, a.role, body.subjectId))) return res.status(403).json({ error: "not your subject" });
    ownerType = a.role === "doctor" ? "doctor" : "ta_shared";
    ownerId = a.userId;
  }
  const optErr = checkOptions(body.questionType, body.options, body.correctAnswer);
  if (optErr) return res.status(422).json({ error: optErr });
  const row = await prisma.question.create({
    data: {
      subjectId: body.subjectId,
      ownerType,
      doctorId: ownerType === "doctor" ? ownerId : null,
      addedByTaId: ownerType === "ta_shared" ? ownerId : null,
      questionType: body.questionType,
      text: body.text,
      options: body.options,
      correctAnswer: body.correctAnswer,
      grade: body.grade,
      difficulty: body.difficulty,
    },
  });
  await audit(a.userId, "question.create", "question", row.id, { subjectId: body.subjectId });
  res.status(201).json(row);
});

async function ownQuestionOr403(userId: string, role: Role, id: string) {
  const q = await prisma.question.findUnique({ where: { id } });
  if (!q) return { error: "not found" as const };
  if (role === "admin") return { q };
  if (role === "doctor" && q.ownerType === "doctor" && q.doctorId === userId) return { q };
  if (role === "ta" && q.ownerType === "ta_shared" && q.addedByTaId === userId) return { q };
  return { error: "not yours" as const };
}

// Whitelist update — ownership/subject can never move via PATCH (transfer attack).
questionBank.patch("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const body = questionBody.omit({ subjectId: true }).partial().parse(req.body);
  // Ownership first: validating options before the check leaks existence of
  // other banks' questions (404/422 vs 403 oracle).
  const own = await ownQuestionOr403(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (body.options || body.correctAnswer || body.questionType) {
    const t = (body.questionType ?? own.q.questionType) as never;
    const o = (body.options ?? (own.q.options as string[])) as string[];
    const c = body.correctAnswer ?? own.q.correctAnswer;
    const optErr = checkOptions(t, o, c);
    if (optErr) return res.status(422).json({ error: optErr });
  }
  const row = await prisma.question.update({ where: { id: own.q.id }, data: body });
  await audit(a.userId, "question.update", "question", row.id, body);
  res.json(row);
});

questionBank.delete("/:id", async (req, res) => {
  const a = req as unknown as AuthedRequest;
  const own = await ownQuestionOr403(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  const used = await prisma.studentExamQuestion.count({ where: { questionId: own.q.id } });
  if (used > 0) return res.status(409).json({ error: "used in student exams" });
  // Compensations reference by ID with Restrict: deleting would 500.
  const comped = await prisma.examCompensation.count({ where: { questionId: own.q.id } });
  if (comped > 0) return res.status(409).json({ error: "has compensations, void is history" });
  // Hand-picked blueprints reference by ID without creating sittings yet —
  // deleting would silently hollow out a locked exam.
  const pinned = await prisma.exam.count({ where: { manualQuestionIds: { array_contains: own.q.id } } });
  if (pinned > 0) return res.status(409).json({ error: "pinned in an exam blueprint" });
  // Auto-sampled guard: a pending/approved exam samples its mix from live
  // pool counts. Deleting the last questions of a tier would make hundreds
  // of Start clicks 422 with "bank short for mix" on exam day.
  // Time-bound to open/upcoming exams: long-finished exams must not block
  // bank maintenance forever.
  const now = new Date();
  const dependent = await prisma.exam.findMany({
    where: {
      subjectId: own.q.subjectId,
      status: { in: ["pending_approval", "approved"] },
      endTime: { gte: now },
    },
    select: { id: true, difficultyMix: true, createdBy: true, type: true, questionSource: true, subjectId: true, manualQuestionIds: true },
  });
  const autoDependent = dependent.filter((ex) => {
    const m = ex.manualQuestionIds as unknown;
    return !Array.isArray(m) || (m as string[]).length === 0;
  });
  if (autoDependent.length) {
    const { poolForExam } = await import("../lib/sampling.js");
    const { poolCounts, mixShortfall } = await import("../lib/examRules.js");
    for (const ex of autoDependent) {
      const pool = await poolForExam(prisma, ex as never);
      if (!pool.ok) continue;
      const counts = await poolCounts(prisma, pool.where);
      // Simulate the pool AFTER this deletion (only matters if the question
      // belongs to the exam's pool scope).
      const inPool = await prisma.question.count({
        where: { id: own.q.id, ...(pool.where as object) },
      });
      if (!inPool) continue;
      const tier = own.q.difficulty as string;
      counts[tier] = Math.max(0, (counts[tier] ?? 0) - 1);
      const short = mixShortfall((ex.difficultyMix ?? {}) as never, counts);
      if (short) {
        return res.status(409).json({ error: "exam depends on this bank tier", examId: ex.id, ...short });
      }
    }
  }
  await prisma.question.delete({ where: { id: own.q.id } });
  await audit(a.userId, "question.delete", "question", own.q.id);
  res.json({ ok: true });
});

// POST /question-bank/:id/image (multipart image=) — the only image path.
questionBank.post("/:id/image", upload.single("image"), async (req, res) => {
  const a = req as unknown as AuthedRequest;
  // Ownership first: existence oracle closed (was 422-before-403).
  const own = await ownQuestionOr403(a.userId, a.role, String(req.params.id));
  if ("error" in own) return res.status(own.error === "not found" ? 404 : 403).json({ error: own.error });
  if (!req.file) return res.status(400).json({ error: "image required" });
  if (!req.file.mimetype.startsWith("image/")) return res.status(422).json({ error: "image only" });
  if (!imageExtOk(req.file.originalname)) return res.status(422).json({ error: "image must be png|jpg|jpeg|webp|gif (no svg)" });
  // Content sniff: extension + client MIME are claims, not proof (polyglots).
  const kind = sniffImage(req.file.buffer);
  if (!kind) return res.status(422).json({ error: "file is not a real png|jpg|gif|webp image" });
  const stored = await storage.put(`questions/${own.q.subjectId}`, req.file.originalname, req.file.buffer);
  const row = await prisma.question.update({ where: { id: own.q.id }, data: { imageUrl: stored.url } });
  await audit(a.userId, "question.image", "question", row.id, { url: stored.url });
  res.json({ imageUrl: stored.url });
});

// Excel columns: subject_code*, question_type(mcq|true_false)*, text*, options(A|B|C)*,
// correct_answer*, grade(number>0)*, difficulty(easy|medium|hard)*, image_filename?
// (admin rows also need owner_type(doctor|ta_shared)* + owner(username)*).
// Zip field "images": filenames matched to image_filename. Multipart: file=, images=.
const bankUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadMaxBytes } }).fields([
  { name: "file", maxCount: 1 },
  { name: "images", maxCount: 1 },
]);

interface BankRow {
  line: number;
  subjectId: string;
  ownerType: "doctor" | "ta_shared";
  ownerId: string;
  questionType: "mcq" | "true_false";
  text: string;
  options: string[];
  correctAnswer: string;
  grade: number;
  difficulty: "easy" | "medium" | "hard";
  imageFilename?: string;
}

async function zipMap(buf?: Buffer): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  if (!buf) return map;
  // Zip-bomb caps: multer limits COMPRESSED bytes; decompressed output is
  // bounded here (entries, per-file, total) before anything hits the heap.
  try {
    const dir = await unzipper.Open.buffer(buf);
    let total = 0;
    let files = 0;
    for (const f of dir.files) {
      if (f.type !== "File") continue;
      if (++files > config.zip.maxFiles) throw new Error("zip has too many files");
      const content = await f.buffer();
      if (content.length > config.zip.maxFileBytes) throw new Error("zip entry too large");
      total += content.length;
      if (total > config.zip.maxTotalBytes) throw new Error("zip decompresses too large");
      const name = f.path.split("/").pop() ?? "";
      if (name) map.set(name, content);
    }
    return map;
  } catch (e) {
    if (e instanceof Error && /zip (has too many|entry too large|decompresses)/.test(e.message)) throw e;
    throw new Error("invalid or corrupted zip archive");
  }
}

class RowSkip extends Error {}

function spreadsheetFileOk(filename: string, mimetype: string): boolean {
  const lower = filename.toLowerCase();
  if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv"))) return false;
  if (/spreadsheet|excel|csv|octet-stream/.test(mimetype.toLowerCase())) return true;
  return false;
}

questionBank.post("/import/dry-run", rateLimit(30, 60_000, "bank-import:dry-run"), bankUpload, async (req, res) => {
  const a = req as unknown as AuthedRequest;
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const files = req.files as { file?: Express.Multer.File[]; images?: Express.Multer.File[] } | undefined;
  const excel = files?.file?.[0];
  if (!excel) return res.status(400).json({ error: "file required" });
  if (!spreadsheetFileOk(excel.originalname, excel.mimetype)) {
    return res.status(422).json({ error: "file must be .xlsx/.xls/.csv" });
  }
  let images: Map<string, Buffer>;
  try {
    images = await zipMap(files?.images?.[0]?.buffer);
  } catch {
    return res.status(422).json({ error: "invalid or corrupted zip archive" });
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(excel.buffer, { type: "buffer" });
  } catch {
    return res.status(422).json({ error: "empty or corrupt file" });
  }
  const first = wb.SheetNames[0];
  if (!wb.SheetNames.length || !first || !wb.Sheets[first]) {
    return res.status(422).json({ error: "empty or corrupt file" });
  }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[first], { defval: "" });
  const str = (v: unknown) => String(v ?? "").trim();
  // Optional target-subject override from the upload form: when the uploader
  // picks a subject in the UI, every row goes there regardless of per-row
  // subject_code cells (which stay valid when no target is picked).
  const targetCode = str((req.body as Record<string, unknown> | undefined)?.subject_code ?? "");
  let targetSubjectId: string | null = null;
  if (targetCode) {
    const t = await prisma.subject.findUnique({ where: { code: targetCode }, select: { id: true } });
    if (!t) return res.status(422).json({ error: `unknown subject_code: ${targetCode}` });
    targetSubjectId = t.id;
  }
  const rows: BankRow[] = [];
  const errors: { line: number; reason: string }[] = [];
  const subjects = new Map<string, string>();
  for (const code of new Set(raw.map((r) => str(r.subject_code)).filter(Boolean))) {
    const s = await prisma.subject.findUnique({ where: { code }, select: { id: true } });
    if (s) subjects.set(code, s.id);
  }
  const users = new Map<string, { id: string; role: Role }>();
  for (const uname of new Set(raw.map((r) => str(r.owner).toLowerCase()).filter(Boolean))) {
    const u = await prisma.user.findUnique({ where: { username: uname }, select: { id: true, role: true } });
    if (u) users.set(uname, u);
  }

  for (const [i, r] of raw.entries()) {
    const line = i + 2;
    try {
    const fail = (reason: string): never => { errors.push({ line, reason }); throw new RowSkip(); };
    const code = targetCode || str(r.subject_code);
    const subjectId = targetSubjectId ?? subjects.get(code);
    if (!subjectId) return fail(`unknown subject_code: ${code || "(empty)"}`);
    const t = str(r.question_type).toLowerCase();
    if (t !== "mcq" && t !== "true_false") return fail(`bad question_type: ${t}`);
    const text = str(r.text);
    if (!text) return fail("missing text");
    const options = str(r.options).split("|").map((s) => s.trim()).filter(Boolean);
    if (options.length < 2) return fail("options needs 2+ pipe-separated values");
    const correctAnswer = str(r.correct_answer);
    const optErr = checkOptions(t, options, correctAnswer);
    if (optErr) return fail(optErr);
    const grade = Number(str(r.grade));
    if (!Number.isFinite(grade) || grade <= 0) return fail(`bad grade: ${str(r.grade)}`);
    const d = str(r.difficulty).toLowerCase();
    if (d !== "easy" && d !== "medium" && d !== "hard") return fail(`bad difficulty: ${d}`);
    const imageFilename = str(r.image_filename) || undefined;
    if (imageFilename && !imageExtOk(imageFilename)) return fail(`bad image type (png|jpg|jpeg|webp|gif only): ${imageFilename}`);
    if (imageFilename && !images.has(imageFilename)) return fail(`image not in zip: ${imageFilename}`);
    if (imageFilename && !sniffImage(images.get(imageFilename)!)) return fail(`image is not a real png|jpg|gif|webp file: ${imageFilename}`);

    let ownerType: BankRow["ownerType"];
    let ownerId: string;
    if (a.role === "admin") {
      const ot = str(r.owner_type).toLowerCase();
      const owner = users.get(str(r.owner).toLowerCase());
      if ((ot !== "doctor" && ot !== "ta_shared") || !owner) return fail("admin rows need owner_type + owner username");
      if ((ot === "doctor" && owner.role !== "doctor") || (ot === "ta_shared" && owner.role !== "ta")) return fail("owner role mismatch");
      ownerType = ot;
      ownerId = owner.id;
      if (!(await mayBank(ownerId, owner.role, subjectId))) return fail("owner not scoped to subject");
    } else if (a.role === "doctor") {
      if (!(await mayBank(a.userId, a.role, subjectId))) return fail("not your subject");
      ownerType = "doctor";
      ownerId = a.userId;
    } else {
      if (!(await mayBank(a.userId, a.role, subjectId))) return fail("not your subject");
      ownerType = "ta_shared";
      ownerId = a.userId;
    }
    rows.push({ line, subjectId, ownerType, ownerId, questionType: t, text, options, correctAnswer, grade, difficulty: d, imageFilename });
    } catch (e) {
      if (!(e instanceof RowSkip)) throw e;
    }
  }

  const batch = await prisma.importBatch.create({
    data: {
      type: "questions",
      uploadedBy: a.userId,
      filename: excel.originalname,
      status: "dry_run",
      totalRows: raw.length,
      validRows: rows.length,
      payload: JSON.parse(JSON.stringify({ rows, withImages: [...images.keys()] })),
      expiresAt: new Date(Date.now() + config.importBatch.ttlMs),
    },
  });
  const appliedSubject = targetCode
    ? await prisma.subject.findUnique({ where: { code: targetCode }, select: { code: true, name: true } })
    : null;
  res.json({ batchId: batch.id, valid: rows.length, errors, expiresAt: batch.expiresAt, subject: appliedSubject, preview: rows.slice(0, 50).map((r) => ({ line: r.line, text: r.text, options: r.options, correctAnswer: r.correctAnswer, grade: r.grade, difficulty: r.difficulty })), previewTruncated: rows.length > 50 });
});

questionBank.post("/import/commit", rateLimit(30, 60_000, "bank-import:commit"), bankUpload, async (req, res) => {
  const a = req as unknown as AuthedRequest;
  // Zip binaries are request-scoped (never persisted): commit re-attaches the
  // same images zip alongside {batchId}. Rows with image_filename fail closed
  // if the file isn't in this zip.
  const body = z.object({ batchId: z.string() }).parse(req.body as Record<string, unknown>);
  // Commit is staff-only AND uploader-scoped: students can neither commit nor
  // hijack another staffer's pending batch (dry-run already blocks students).
  if (a.role === "student") return res.status(403).json({ error: "forbidden" });
  const pre = await prisma.importBatch.findUnique({ where: { id: body.batchId } });
  if (!pre || pre.type !== "questions") return res.status(404).json({ error: "batch not found" });
  if (pre.uploadedBy !== a.userId && a.role !== "admin") return res.status(403).json({ error: "not your batch" });
  if (pre.status !== "dry_run" || pre.expiresAt.getTime() < Date.now()) {
    if (pre.expiresAt.getTime() < Date.now()) {
      await prisma.importBatch.update({ where: { id: body.batchId }, data: { status: "expired", payload: {} } });
      return res.status(409).json({ error: "batch expired" });
    }
    return res.status(409).json({ error: `already ${pre.status}` });
  }
  // Scope recheck with LIVE roles: assignments may have changed since dry-run.
  // The images zip is parsed BEFORE the atomic claim: zip bytes are
  // request-scoped (never persisted), so a corrupt zip must 422 while the
  // batch is still dry_run and retryable — not stuck `committed`.
  const cfiles = req.files as { images?: Express.Multer.File[] } | undefined;
  let cimages: Map<string, Buffer>;
  try {
    cimages = await zipMap(cfiles?.images?.[0]?.buffer);
  } catch {
    return res.status(422).json({ error: "invalid or corrupted zip archive" });
  }
  const stagedPre = pre.payload as unknown as { rows: BankRow[] };
  const owners = new Map<string, { id: string; role: Role }>();
  for (const r of stagedPre.rows) {
    if (!owners.has(r.ownerId)) {
      const u = await prisma.user.findUnique({ where: { id: r.ownerId }, select: { id: true, role: true } });
      if (u) owners.set(r.ownerId, u);
    }
  }
  for (const r of stagedPre.rows) {
    const o = owners.get(r.ownerId);
    if (!o || !(await mayBank(r.ownerId, o.role, r.subjectId))) {
      return res.status(409).json({ error: "owner lost subject scope since dry-run" });
    }
  }
  const claimed = await prisma.importBatch.updateMany({
    where: { id: body.batchId, type: "questions", status: "dry_run", expiresAt: { gt: new Date() } },
    data: { status: "committed" },
  });
  if (claimed.count === 0) {
    const b = await prisma.importBatch.findUnique({ where: { id: body.batchId }, select: { status: true, expiresAt: true, type: true } });
    if (!b || b.type !== "questions") return res.status(404).json({ error: "batch not found" });
    if (b.expiresAt.getTime() < Date.now()) {
      await prisma.importBatch.update({ where: { id: body.batchId }, data: { status: "expired", payload: {} } });
    }
    return res.status(409).json({ error: b.expiresAt.getTime() < Date.now() ? "batch expired" : `already ${b.status}` });
  }
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: body.batchId } });
  const staged = batch.payload as unknown as { rows: BankRow[] };

  let created = 0;
  const rowErrors: { line: number; reason: string }[] = [];
  const subCodes = new Map<string, string>(); // subjectId -> code memo (was N queries)
  try {
    for (let i = 0; i < staged.rows.length; i += 100) {
    const docs: {
      subjectId: string; ownerType: "doctor" | "ta_shared"; doctorId: string | null; addedByTaId: string | null;
      questionType: "mcq" | "true_false"; text: string; options: object; correctAnswer: string;
      grade: number; difficulty: "easy" | "medium" | "hard"; imageUrl: string | null;
    }[] = [];
    for (const r of staged.rows.slice(i, i + 100)) {
      try {
        let imageUrl: string | null = null;
        if (r.imageFilename) {
          if (!imageExtOk(r.imageFilename)) throw new Error(`bad image type: ${r.imageFilename}`);
          const buf = cimages.get(r.imageFilename);
          if (!buf) throw new Error(`image not in zip: ${r.imageFilename}`);
          if (!sniffImage(buf)) throw new Error(`image is not a real png|jpg|gif|webp file: ${r.imageFilename}`);
          subCodes.set(
            r.subjectId,
            subCodes.get(r.subjectId) ?? (await prisma.subject.findUnique({ where: { id: r.subjectId }, select: { code: true } }))?.code ?? r.subjectId,
          );
          imageUrl = (await storage.put(`questions/${subCodes.get(r.subjectId)}`, r.imageFilename, buf)).url;
        }
        docs.push({
          subjectId: r.subjectId, ownerType: r.ownerType,
          doctorId: r.ownerType === "doctor" ? r.ownerId : null,
          addedByTaId: r.ownerType === "ta_shared" ? r.ownerId : null,
          questionType: r.questionType, text: r.text, options: r.options as unknown as object,
          correctAnswer: r.correctAnswer, grade: r.grade, difficulty: r.difficulty, imageUrl,
        });
      } catch (e) {
        rowErrors.push({ line: r.line, reason: e instanceof Error ? e.message : "failed" });
      }
    }
      if (docs.length) {
        try {
          created += (await prisma.question.createMany({ data: docs as never })).count;
        } catch (e) {
          // Chunk write failed (e.g. subject removed mid-commit): record and
          // continue like a row error instead of 500ing the whole batch.
          rowErrors.push({ line: staged.rows[i].line, reason: e instanceof Error ? e.message : "chunk failed" });
        }
      }
    }
  } catch (e) {
    // Unexpected failure after claim (DB blip, disk full): revert to dry_run
    // so the batch is retryable instead of stuck-committed. Rows already
    // written stay written — the 500 reports how many, so the operator can
    // dedupe before retrying.
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "dry_run" } });
    return res.status(500).json({ error: "commit failed partway", created, errors: rowErrors });
  }
  await prisma.importBatch.update({ where: { id: batch.id }, data: { payload: {} } });
  const log = await prisma.excelImportLog.create({
    data: { importType: "questions", batchId: batch.id, uploadedBy: a.userId, filename: batch.filename, totalRows: batch.totalRows, importedCount: created, errorCount: rowErrors.length, errorReport: rowErrors },
  });
  await audit(a.userId, "question.import", "import_batch", batch.id, { created, errors: rowErrors.length });
  res.json({ ok: true, created, errors: rowErrors, logId: log.id });
});
