import { shuffled } from "./shuffle.js";

export const QUESTION_TYPES = [
  "mcq",
  "true_false",
  "multi_select",
  "short_answer",
  "essay",
  "matching",
  "ordering",
] as const;

export type QuestionTypeValue = (typeof QUESTION_TYPES)[number];

export interface MatchingPair {
  left: string;
  right: string;
}

export interface MatchingOptions {
  pairs: MatchingPair[];
}

export interface StudentMatchingOptions {
  left: string[];
  right: string[];
}

function normText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function extractMatchingPairs(options: unknown): MatchingPair[] | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const raw = (options as Record<string, unknown>).pairs;
  if (!Array.isArray(raw)) return null;
  const pairs: MatchingPair[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const left = String((item as Record<string, unknown>).left ?? "").trim();
    const right = String((item as Record<string, unknown>).right ?? "").trim();
    if (!left || !right) return null;
    pairs.push({ left, right });
  }
  return pairs;
}

export function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Validates and normalizes `options` and `correctAnswer` for any question type
 * when creating or editing a question in the question bank.
 */
export function normalizeQuestionSpec(
  type: QuestionTypeValue,
  rawOptions: unknown,
  rawCorrect: string,
): { ok: true; options: unknown; correctAnswer: string } | { ok: false; error: string } {
  if (type === "mcq" || type === "true_false") {
    if (!Array.isArray(rawOptions)) return { ok: false, error: "options must be a list of choices" };
    const trimmed = rawOptions.map((o) => String(o ?? "").trim());
    if (trimmed.length < 2 || trimmed.length > 6) return { ok: false, error: "options must have 2 to 6 choices" };
    if (trimmed.some((o) => !o)) return { ok: false, error: "options cannot be empty" };
    if (new Set(trimmed).size !== trimmed.length) return { ok: false, error: "options must be unique" };
    const correct = rawCorrect.trim();
    if (!trimmed.includes(correct)) return { ok: false, error: "correctAnswer must be one of options" };
    if (type === "true_false") {
      const low = trimmed.map((o) => o.toLowerCase());
      if (low.length !== 2 || !low.includes("true") || !low.includes("false")) {
        return { ok: false, error: "true_false requires options [True, False]" };
      }
    }
    return { ok: true, options: trimmed, correctAnswer: correct };
  }

  if (type === "multi_select") {
    if (!Array.isArray(rawOptions)) return { ok: false, error: "options must be a list of choices" };
    const trimmed = rawOptions.map((o) => String(o ?? "").trim());
    if (trimmed.length < 2 || trimmed.length > 8) return { ok: false, error: "multi_select requires 2 to 8 choices" };
    if (trimmed.some((o) => !o)) return { ok: false, error: "options cannot be empty" };
    if (new Set(trimmed).size !== trimmed.length) return { ok: false, error: "options must be unique" };
    const parsed = safeJsonParse<unknown>(rawCorrect);
    const arr = Array.isArray(parsed)
      ? parsed.map((x) => String(x ?? "").trim()).filter(Boolean)
      : rawCorrect
          .split("|")
          .map((x) => x.trim())
          .filter(Boolean);
    const uniqueCorrect = [...new Set(arr)];
    if (!uniqueCorrect.length) return { ok: false, error: "select at least one correct answer" };
    if (uniqueCorrect.some((c) => !trimmed.includes(c))) {
      return { ok: false, error: "every correct answer must be one of the options" };
    }
    return { ok: true, options: trimmed, correctAnswer: JSON.stringify(uniqueCorrect.sort()) };
  }

  if (type === "short_answer") {
    const acceptedRaw = Array.isArray(rawOptions)
      ? rawOptions.map((o) => String(o ?? "").trim()).filter(Boolean)
      : rawCorrect
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
    const accepted = [...new Set(acceptedRaw)];
    if (!accepted.length) return { ok: false, error: "provide at least one accepted short answer" };
    if (accepted.length > 20) return { ok: false, error: "at most 20 accepted answers" };
    return { ok: true, options: accepted, correctAnswer: accepted[0] };
  }

  if (type === "essay") {
    // Essay has no auto-graded options; optional model answer/rubric is stored in correctAnswer.
    const rubric = rawCorrect.trim().slice(0, 5000);
    return { ok: true, options: [], correctAnswer: rubric };
  }

  if (type === "matching") {
    const pairs = extractMatchingPairs(rawOptions);
    if (!pairs || pairs.length < 2 || pairs.length > 8) {
      return { ok: false, error: "matching requires 2 to 8 non-empty left/right pairs" };
    }
    if (new Set(pairs.map((p) => p.left)).size !== pairs.length) {
      return { ok: false, error: "matching left-side prompts must be unique" };
    }
    if (new Set(pairs.map((p) => p.right)).size !== pairs.length) {
      return { ok: false, error: "matching right-side answers must be unique" };
    }
    const keyMap: Record<string, string> = {};
    for (const p of pairs) keyMap[p.left] = p.right;
    return { ok: true, options: { pairs }, correctAnswer: JSON.stringify(keyMap) };
  }

  if (type === "ordering") {
    if (!Array.isArray(rawOptions)) return { ok: false, error: "ordering requires a list of items in the correct order" };
    const trimmed = rawOptions.map((o) => String(o ?? "").trim());
    if (trimmed.length < 2 || trimmed.length > 8) return { ok: false, error: "ordering requires 2 to 8 items" };
    if (trimmed.some((o) => !o)) return { ok: false, error: "ordering items cannot be empty" };
    if (new Set(trimmed).size !== trimmed.length) return { ok: false, error: "ordering items must be unique" };
    return { ok: true, options: trimmed, correctAnswer: JSON.stringify(trimmed) };
  }

  return { ok: false, error: `unsupported question type: ${String(type)}` };
}

/**
 * Projects question options safely for a student exam sitting — never leaking
 * accepted answers, rubrics, or matching/ordering keys!
 */
export function projectOptionsForStudent(
  type: QuestionTypeValue,
  options: unknown,
  seed: string,
): unknown {
  if (type === "short_answer" || type === "essay") {
    return [];
  }
  if (type === "true_false") {
    return Array.isArray(options) ? options : ["True", "False"];
  }
  if (type === "mcq" || type === "multi_select") {
    return Array.isArray(options) ? shuffled(options, seed) : [];
  }
  if (type === "ordering") {
    if (!Array.isArray(options)) return [];
    let out = shuffled(options, seed);
    // If the shuffle happened to land on the exact solution order for 2+ items, rotate by 1.
    if (out.length >= 2 && out.every((v, i) => v === options[i])) {
      out = [...out.slice(1), out[0]];
    }
    return out;
  }
  if (type === "matching") {
    const pairs = extractMatchingPairs(options);
    if (!pairs) return { left: [], right: [] };
    const left = shuffled(
      pairs.map((p) => p.left),
      `${seed}:L`,
    );
    let right = shuffled(
      pairs.map((p) => p.right),
      `${seed}:R`,
    );
    if (right.length >= 2 && right.every((v, i) => v === pairs.find((p) => p.left === left[i])?.right)) {
      right = [...right.slice(1), right[0]];
    }
    return { left, right } satisfies StudentMatchingOptions;
  }
  return options;
}

/**
 * Validates and canonicalizes a student's submitted answer payload before saving.
 */
export function validateStudentAnswer(
  type: QuestionTypeValue,
  options: unknown,
  selected: string | null,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (selected === null || selected === "") return { ok: true, value: null };

  if (type === "mcq" || type === "true_false") {
    const valid = Array.isArray(options) ? (options as string[]) : [];
    if (!valid.includes(selected)) {
      return { ok: false, error: "selectedAnswer must be one of the question options" };
    }
    return { ok: true, value: selected };
  }

  if (type === "multi_select") {
    const valid = new Set(Array.isArray(options) ? (options as string[]) : []);
    const parsed = safeJsonParse<unknown>(selected);
    if (!Array.isArray(parsed)) return { ok: false, error: "multi_select answer must be a JSON array" };
    const picks = [...new Set(parsed.map((x) => String(x)))];
    if (!picks.length) return { ok: true, value: null };
    if (picks.some((p) => !valid.has(p))) {
      return { ok: false, error: "every selected option must belong to this question" };
    }
    return { ok: true, value: JSON.stringify(picks.sort()) };
  }

  if (type === "short_answer") {
    const trimmed = selected.trim();
    if (!trimmed) return { ok: true, value: null };
    if (trimmed.length > 500) return { ok: false, error: "short answer must be 500 characters or less" };
    return { ok: true, value: trimmed };
  }

  if (type === "essay") {
    const trimmed = selected.trim();
    if (!trimmed) return { ok: true, value: null };
    if (trimmed.length > 15_000) return { ok: false, error: "essay answer must be 15,000 characters or less" };
    return { ok: true, value: selected };
  }

  if (type === "matching") {
    const pairs = extractMatchingPairs(options);
    if (!pairs) return { ok: false, error: "invalid matching question" };
    const leftSet = new Set(pairs.map((p) => p.left));
    const rightSet = new Set(pairs.map((p) => p.right));
    const parsed = safeJsonParse<unknown>(selected);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "matching answer must be a JSON object" };
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const sv = String(v ?? "").trim();
      if (!sv) continue;
      if (!leftSet.has(k) || !rightSet.has(sv)) {
        return { ok: false, error: "matching selection contains an invalid item" };
      }
      clean[k] = sv;
    }
    if (!Object.keys(clean).length) return { ok: true, value: null };
    return { ok: true, value: JSON.stringify(clean) };
  }

  if (type === "ordering") {
    const valid = Array.isArray(options) ? (options as string[]) : [];
    const parsed = safeJsonParse<unknown>(selected);
    if (!Array.isArray(parsed)) return { ok: false, error: "ordering answer must be a JSON array" };
    const arr = parsed.map((x) => String(x));
    if (arr.length !== valid.length || new Set(arr).size !== valid.length || arr.some((x) => !valid.includes(x))) {
      return { ok: false, error: "ordering answer must contain all items exactly once" };
    }
    return { ok: true, value: JSON.stringify(arr) };
  }

  return { ok: false, error: "unsupported question type" };
}

/**
 * Computes raw auto-graded score (0..fullGrade) for any question type.
 * Essays always return 0 on auto-grade (instructor grades manually).
 */
export function scoreQuestionAnswer(
  type: QuestionTypeValue,
  selectedAnswer: string | null,
  correctAnswer: string,
  options: unknown,
  fullGrade: number,
): { score: number; isFullCredit: boolean; requiresManualGrading: boolean } {
  if (type === "essay") {
    return { score: 0, isFullCredit: false, requiresManualGrading: true };
  }
  if (selectedAnswer === null || selectedAnswer === "") {
    return { score: 0, isFullCredit: false, requiresManualGrading: false };
  }

  if (type === "mcq" || type === "true_false") {
    const ok = selectedAnswer === correctAnswer;
    return { score: ok ? fullGrade : 0, isFullCredit: ok, requiresManualGrading: false };
  }

  if (type === "multi_select") {
    const expected = new Set(safeJsonParse<string[]>(correctAnswer) ?? []);
    const picked = new Set(safeJsonParse<string[]>(selectedAnswer) ?? []);
    if (!expected.size) return { score: 0, isFullCredit: false, requiresManualGrading: false };
    let hits = 0;
    let wrong = 0;
    for (const p of picked) {
      if (expected.has(p)) hits++;
      else wrong++;
    }
    const exact = hits === expected.size && wrong === 0;
    if (exact) return { score: fullGrade, isFullCredit: true, requiresManualGrading: false };
    const ratio = Math.max(0, (hits - wrong) / expected.size);
    return { score: Number((ratio * fullGrade).toFixed(2)), isFullCredit: false, requiresManualGrading: false };
  }

  if (type === "short_answer") {
    const accepted = Array.isArray(options)
      ? (options as string[]).map(normText).filter(Boolean)
      : [normText(correctAnswer)];
    if (!accepted.includes(normText(correctAnswer))) accepted.push(normText(correctAnswer));
    const ok = accepted.includes(normText(selectedAnswer));
    return { score: ok ? fullGrade : 0, isFullCredit: ok, requiresManualGrading: false };
  }

  if (type === "matching") {
    const expected = safeJsonParse<Record<string, string>>(correctAnswer) ?? {};
    const picked = safeJsonParse<Record<string, string>>(selectedAnswer) ?? {};
    const keys = Object.keys(expected);
    if (!keys.length) return { score: 0, isFullCredit: false, requiresManualGrading: false };
    let hits = 0;
    for (const k of keys) {
      if (picked[k] && picked[k] === expected[k]) hits++;
    }
    const exact = hits === keys.length;
    return {
      score: exact ? fullGrade : Number(((hits / keys.length) * fullGrade).toFixed(2)),
      isFullCredit: exact,
      requiresManualGrading: false,
    };
  }

  if (type === "ordering") {
    const expected = safeJsonParse<string[]>(correctAnswer) ?? [];
    const picked = safeJsonParse<string[]>(selectedAnswer) ?? [];
    if (!expected.length || picked.length !== expected.length) {
      return { score: 0, isFullCredit: false, requiresManualGrading: false };
    }
    let hits = 0;
    for (let i = 0; i < expected.length; i++) {
      if (picked[i] === expected[i]) hits++;
    }
    const exact = hits === expected.length;
    return {
      score: exact ? fullGrade : Number(((hits / expected.length) * fullGrade).toFixed(2)),
      isFullCredit: exact,
      requiresManualGrading: false,
    };
  }

  return { score: 0, isFullCredit: false, requiresManualGrading: false };
}
