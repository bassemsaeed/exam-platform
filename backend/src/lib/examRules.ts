export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Mix = Partial<Record<(typeof DIFFICULTIES)[number], number>>;

// Window + duration guard shared by admin patch and staff create/patch.
export function checkWindow(start: Date, end: Date, durationMinutes: number): string | null {
  if (!(start < end)) return "startTime must be before endTime";
  if (durationMinutes * 60_000 > end.getTime() - start.getTime()) return "duration exceeds exam window";
  return null;
}

export function checkMix(mix: unknown): mix is Mix {
  if (typeof mix !== "object" || mix === null) return false;
  const entries = Object.entries(mix as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => DIFFICULTIES.includes(k as never) && Number.isInteger(v) && (v as number) >= 0);
}

// Counts available in a question pool: {easy, medium, hard} (missing tiers = 0).
export async function poolCounts(
  prisma: {
    question: { groupBy(args: { by: ["difficulty"]; where: object; _count: true }): Promise<{ difficulty: string; _count: number }[]> };
  },
  where: object,
): Promise<Record<string, number>> {
  const rows = await prisma.question.groupBy({ by: ["difficulty"], where, _count: true });
  const out: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  for (const r of rows) out[r.difficulty] = r._count;
  return out;
}

// Spec §3.2: block (never silently repeat) when any tier is short.
export function mixShortfall(mix: Mix, have: Record<string, number>): { need: Mix; have: Mix } | null {
  const need: Mix = {};
  const short: Mix = {};
  for (const tier of DIFFICULTIES) {
    const n = mix[tier] ?? 0;
    if (n > 0) {
      need[tier] = n;
      if ((have[tier] ?? 0) < n) short[tier] = have[tier] ?? 0;
    }
  }
  return Object.keys(short).length ? { need, have: short } : null;
}
