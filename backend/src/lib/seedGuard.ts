// Seed safety: demo/destructive seeds must never run against a real database
// by accident (fixed passwords, published SEB dev key, exam wipes).
export function assertSeedAllowed(kind: "test-data" | "destructive"): void {
  if (process.env.NODE_ENV === "production" && process.env[`ALLOW_${kind === "destructive" ? "DESTRUCTIVE_SEED" : "SEED_TEST_DATA"}`] !== "true") {
    throw new Error(
      `refusing to run in NODE_ENV=production without ${kind === "destructive" ? "ALLOW_DESTRUCTIVE_SEED" : "ALLOW_SEED_TEST_DATA"}=true — see backend/.env.example`,
    );
  }
  if (process.env.DATABASE_URL?.includes("exam_platform") === false) {
    console.warn(`seed ${kind}: DATABASE_URL does not look like a dev database — double-check before continuing`);
  }
}
