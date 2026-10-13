// Seed safety: demo/destructive seeds must never run against a real database
// by accident (fixed passwords, published SEB dev key, exam wipes).
// Allowed only when BOTH hold:
//   1. NODE_ENV !== 'production' (production is always refused), AND
//   2. the target looks local (DATABASE_URL has localhost/127.0.0.1)
//      OR an explicit ALLOW_SEED=1 escape hatch is set.
// Legacy kind flags (ALLOW_SEED_TEST_DATA / ALLOW_DESTRUCTIVE_SEED) are still
// honoured so existing checkouts keep working.
export function assertSeedAllowed(kind: "seed" | "test-data" | "destructive" = "seed"): void {
  const nodeEnv = process.env.NODE_ENV ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const allowSeed = process.env.ALLOW_SEED === "1" || process.env.ALLOW_SEED === "true";
  const legacyFlag =
    kind === "destructive" ? "ALLOW_DESTRUCTIVE_SEED" : kind === "test-data" ? "ALLOW_SEED_TEST_DATA" : "";
  const legacyAllow =
    legacyFlag !== "" && (process.env[legacyFlag] === "true" || process.env[legacyFlag] === "1");
  const looksLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
  if (nodeEnv !== "production" && (looksLocal || allowSeed || legacyAllow)) return;
  const hint =
    kind === "destructive"
      ? "refusing destructive seed: requires NODE_ENV!=production AND (local DATABASE_URL OR ALLOW_SEED=1)"
      : kind === "test-data"
        ? "refusing test-data seed: requires NODE_ENV!=production AND (local DATABASE_URL OR ALLOW_SEED=1)"
        : "refusing seed: requires NODE_ENV!=production AND (local DATABASE_URL OR ALLOW_SEED=1)";
  throw new Error(`${hint} (NODE_ENV=${nodeEnv || "(unset)"}, DATABASE_URL=${dbUrl ? "[set]" : "[unset]"}) — see backend/.env.example`);
}
