import { PrismaClient } from "../generated/prisma/client.js";
import { DIFFICULTIES, type Mix } from "./examRules.js";
import { poolWhere } from "../routes/exams.js";

// Fisher-Yates shuffle in O(N) memory & time.
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i];
    out[i] = out[j];
    out[j] = temp;
  }
  return out;
}

export interface SampleResult {
  ok: true;
  questionIds: string[];
}

export interface SampleShortfall {
  ok: false;
  error: string;
  need?: Mix;
  have?: Mix;
}

type PoolPrisma = {
  user: {
    findUnique(args: { where: { id: string }; select: { role: true } }): Promise<{ role: string } | null>;
  };
};

// Pool for an EXISTING exam using its creator's REAL role (admins sample the
// whole subject pool — same pool the create-time check used). Shared by
// sampling, staff patch and admin patch so all three agree.
export async function poolForExam(
  prisma: PoolPrisma,
  exam: {
    createdBy: string;
    type: "doctor_exam" | "ta_quiz";
    subjectId: string;
    questionSource: string | null;
  },
): Promise<{ ok: true; where: object } | { ok: false; error: string }> {
  const creator = await prisma.user.findUnique({ where: { id: exam.createdBy }, select: { role: true } });
  const role = creator?.role ?? (exam.type === "doctor_exam" ? "doctor" : "ta");
  const source =
    (exam.questionSource as "own" | "shared" | "mine" | null) ??
    (exam.type === "doctor_exam" ? "own" : "shared");
  return poolWhere(exam.createdBy, role, exam.subjectId, source);
}

/**
 * Samples questions for a student exam per difficulty mix.
 * Performance critical (5k ceiling): Completely avoids `ORDER BY random()`,
 * which triggers expensive sequential scans and in-database temp files.
 * Instead, queries indexed question IDs per tier and shuffles in memory.
 */
export async function sampleExamQuestions(
  prisma: PoolPrisma & {
    question: {
      findMany(args: { where: object; select: { id: true } }): Promise<{ id: string }[]>;
      count(args: { where: object }): Promise<number>;
    };
  },
  exam: {
    id: string;
    subjectId: string;
    createdBy: string;
    type: "doctor_exam" | "ta_quiz";
    questionSource: string | null;
    difficultyMix: unknown;
    manualQuestionIds?: unknown;
  },
): Promise<SampleResult | SampleShortfall> {
  // Hand-picked blueprint: author's exact questions in author order (no
  // shuffle — sequence is part of the design). Missing rows (deleted after
  // the blueprint locked... which the delete guard prevents) fail loudly.
  const manual = Array.isArray(exam.manualQuestionIds) ? (exam.manualQuestionIds as string[]) : [];
  if (manual.length > 0) {
    const rows = await prisma.question.findMany({
      where: { id: { in: manual } },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = manual.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return { ok: false, error: "blueprint changed: pinned questions no longer exist" };
    }
    // Pool check: pinned IDs must live in the exam's own bank scope. Create
    // validates this, but sampling is the last line of defense (a manual
    // blueprint must never serve another bank's questions).
    const pool = await poolForExam(prisma, exam);
    if (!pool.ok) {
      return { ok: false, error: pool.error };
    }
    const inScope = await prisma.question.count({ where: { id: { in: manual }, ...pool.where } });
    if (inScope !== manual.length) {
      return { ok: false, error: "blueprint contains out-of-pool questions" };
    }
    return { ok: true, questionIds: manual };
  }

  const mix = (exam.difficultyMix as Mix) ?? {};

  const pool = await poolForExam(prisma, exam);
  if (!pool.ok) {
    return { ok: false, error: pool.error };
  }

  const selectedIds: string[] = [];
  const need: Mix = {};
  const short: Mix = {};

  for (const tier of DIFFICULTIES) {
    const count = mix[tier] ?? 0;
    if (count <= 0) continue;
    need[tier] = count;

    // Index-only scan on (subject_id, difficulty) / (subject_id, owner_type)
    const rows = await prisma.question.findMany({
      where: { ...pool.where, difficulty: tier },
      select: { id: true },
    });

    if (rows.length < count) {
      short[tier] = rows.length;
    } else {
      const shuffledIds = shuffle(rows.map((r) => r.id));
      selectedIds.push(...shuffledIds.slice(0, count));
    }
  }

  if (Object.keys(short).length > 0) {
    return { ok: false, error: "bank short for mix", need, have: short };
  }

  // Interleave and randomize question order across all difficulty tiers
  return { ok: true, questionIds: shuffle(selectedIds) };
}
