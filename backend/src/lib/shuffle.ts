// Deterministic per-student shuffling: every attempt sees a stable,
// student-unique question and option order. Seed = studentExam.id (+ salt),
// so refreshes/resumes are identical but two students never match.
// Pure functions — unit-tested via tsx, no DB needed.

/** FNV-1a 32-bit string hash. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: deterministic [0,1) stream from a 32-bit seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates using the seeded stream. Returns a NEW array. */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const rand = rng(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
