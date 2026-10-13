function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number (got ${raw})`);
  return v;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — copy backend/.env.example to backend/.env`);
  return v;
}

//load-bearing: SECRET is validated here (not in auth.ts) so misconfig fails fast at boot
// Empty is NOT allowed: sessions must never be signed without a real secret.
const secret = process.env.BETTER_AUTH_SECRET ?? "";
if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be >= 32 chars — copy backend/.env.example to backend/.env");

// Same fail-fast for the SEB envelope key: sebCrypto only checks it lazily, so
// without this the server boots "healthy" and then 500s on every SEB
// register/verify/rotate call. 32 bytes as hex (64 hex chars).
const encHex = process.env.ENCRYPTION_KEY ?? "";
if (!/^[0-9a-fA-F]{64}$/.test(encHex)) throw new Error("ENCRYPTION_KEY must be 32 bytes as hex (generate: openssl rand -hex 32)");

export const config = {
  port: num("PORT", 4000),
  frontendOrigins: str("FRONTEND_URL", "http://localhost:5173").split(","),
  databaseUrl: process.env.DATABASE_URL ?? "", // validated in prisma.ts with its own message
  authSecret: secret,
  authUrl: str("BETTER_AUTH_URL", "http://localhost:4000"),
  pool: {
    max: num("POOL_MAX", 20),
    idleMs: num("POOL_IDLE_MS", 10_000),
    connectMs: num("POOL_CONNECT_MS", 5_000),
    statementMs: num("POOL_STATEMENT_MS", 30_000),
  },
  sessionHours: num("SESSION_HOURS", 12),
  authRateLimit: { max: num("RATE_AUTH_MAX", 60), windowMs: num("RATE_AUTH_WINDOW_MS", 60_000) },
  bodyLimit: str("BODY_LIMIT", "2mb"),
  pagination: { defaultLimit: num("PAGE_DEFAULT", 20), maxLimit: num("PAGE_MAX", 100) },
  uploadMaxBytes: num("UPLOAD_MAX_MB", 10) * 1024 * 1024,
  importBatch: { ttlMs: num("IMPORT_TTL_MIN", 30) * 60_000, hashConcurrency: num("IMPORT_HASH_CONCURRENCY", 25) },
  password: { minLength: num("PASSWORD_MIN", 8) },
  heartbeat: { staleMs: num("HEARTBEAT_STALE_MS", 90_000) },
  studentRateLimit: {
    startMax: num("RATE_STUDENT_START_MAX", 30),
    startWindowMs: num("RATE_STUDENT_START_WINDOW_MS", 60_000),
    submitMax: num("RATE_STUDENT_SUBMIT_MAX", 30),
    submitWindowMs: num("RATE_STUDENT_SUBMIT_WINDOW_MS", 60_000),
    heartbeatMax: num("RATE_STUDENT_HEARTBEAT_MAX", 10),
    heartbeatWindowMs: num("RATE_STUDENT_HEARTBEAT_WINDOW_MS", 60_000),
    flagMax: num("RATE_STUDENT_FLAG_MAX", 30),
    flagWindowMs: num("RATE_STUDENT_FLAG_WINDOW_MS", 60_000),
    answerMax: num("RATE_STUDENT_ANSWER_MAX", 120),
    answerWindowMs: num("RATE_STUDENT_ANSWER_WINDOW_MS", 60_000),
  },
  idempotencyTtlMs: num("IDEMPOTENCY_TTL_MS", 300_000),
  sseKeepAliveMs: num("SSE_KEEP_ALIVE_MS", 15_000),
  sseReplayMax: num("SSE_REPLAY_MAX", 200),
  sebCacheMs: num("SEB_CACHE_MS", 60_000),
  answersBatchMax: num("ANSWERS_BATCH_MAX", 200),
  zip: {
    maxFiles: num("ZIP_MAX_FILES", 200),
    maxFileBytes: num("ZIP_MAX_FILE_MB", 5) * 1024 * 1024,
    maxTotalBytes: num("ZIP_MAX_TOTAL_MB", 50) * 1024 * 1024,
  },
  sweep: { pollMs: num("SWEEP_POLL_MS", 30_000), batchMax: num("SWEEP_BATCH_MAX", 100) },
  exportJob: { pollMs: num("EXPORT_POLL_MS", 5_000), pageSize: num("EXPORT_PAGE_SIZE", 500), syncMaxRows: num("EXPORT_SYNC_MAX_ROWS", 2000) },
  seb: {
    header: str("SEB_HEADER", "X-SafeExamBrowser-RequestHash"),
    minKeyLength: num("SEB_MIN_KEY_LENGTH", 16),
    bootstrapKeys: (process.env.SEB_BOOTSTRAP_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  trustProxy: num("TRUST_PROXY", 1),
  // Express trusts X-Forwarded-For ONLY from these peers (proxy-addr names
  // like "loopback" plus IPs/CIDRs). Direct-client XFF is ignored, so rotating
  // the header cannot rotate rate-limit buckets. Production behind an LB must
  // list the LB here instead of trusting hop counts.
  proxyTrust: ((): string[] | number => {
    const ips = str("TRUSTED_PROXY_IPS", "");
    return ips ? ips.split(",").map((s) => s.trim()).filter(Boolean) : num("TRUST_PROXY", 1);
  })(),
  // Same discipline for Better Auth's own limiter (CIDR syntax there).
  authProxyCidrs: str("AUTH_TRUSTED_PROXY_CIDRS", "127.0.0.1/32,::1/128")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  email: { placeholderDomain: str("EMAIL_PLACEHOLDER_DOMAIN", "uni.local") },
  lists: {
    membersMax: num("LIST_MEMBERS_MAX", 500),
    compensateMax: num("LIST_COMPENSATE_MAX", 5000),
    exportsMax: num("LIST_EXPORTS_MAX", 50),
    examTargetsMax: num("LIST_EXAM_TARGETS_MAX", 500),
    // Grouped results need bigger pages than the generic PAGE_MAX=100: a lab
    // roster must never silently clip. Separate explicit cap, not a PAGE_MAX override.
    resultsMax: num("LIST_RESULTS_MAX", 1000),
  },
  storage: {
    // Empty S3_ENDPOINT = local disk (single-server dev only). Set endpoint
    // for MinIO/S3 in any shared/multi-server setup — local files don't sync.
    dir: str("UPLOAD_DIR", ""),
    s3Endpoint: str("S3_ENDPOINT", ""),
    s3Bucket: str("S3_BUCKET", "exam-platform"),
    s3Region: str("S3_REGION", "us-east-1"),
    s3AccessKey: str("S3_ACCESS_KEY", ""),
    s3SecretKey: str("S3_SECRET_KEY", ""),
    s3PublicUrl: str("S3_PUBLIC_URL", ""),
  },
  redis: {
    // Empty = in-process rate-limit buckets + SSE bus (single-server dev).
    // Set REDIS_URL in any multi-server deployment for cluster-wide limits
    // and cross-instance exam broadcasts.
    url: str("REDIS_URL", ""),
  },
  seed: {
    termName: str("SEED_TERM_NAME", "Fall-2026"),
    termStart: str("SEED_TERM_START", "2026-09-01"),
    termEnd: str("SEED_TERM_END", "2026-12-31"),
  },
};

{
  // Fail fast on an unusable seed term: seed.ts parses these with `new Date`,
  // which silently yields Invalid Date for typos — then Prisma throws a
  // cryptic error mid-seed. Validate format and ordering once at boot.
  const start = new Date(config.seed.termStart);
  const end = new Date(config.seed.termEnd);
  if (Number.isNaN(start.getTime())) throw new Error(`SEED_TERM_START is not a valid date (got ${JSON.stringify(config.seed.termStart)}) — use YYYY-MM-DD`);
  if (Number.isNaN(end.getTime())) throw new Error(`SEED_TERM_END is not a valid date (got ${JSON.stringify(config.seed.termEnd)}) — use YYYY-MM-DD`);
  if (!(start < end)) throw new Error(`SEED_TERM_START (${config.seed.termStart}) must be before SEED_TERM_END (${config.seed.termEnd})`);
}

// SEB bootstrap keys: empty is fine for local dev (seed just skips SEB rows),
// but a production boot without any lab key means SEB verification can never
// succeed — warn loudly so it is not mistaken for a working SEB gate.
if (config.seb.bootstrapKeys.length === 0 && (process.env.NODE_ENV === "production")) {
  console.warn("SEB_BOOTSTRAP_KEYS is empty in NODE_ENV=production — no SEB lab key will be seeded and SEB-gated routes will reject all clients");
} else {
  for (const raw of config.seb.bootstrapKeys) {
    if (raw.length < config.seb.minKeyLength) {
      console.warn(`SEB bootstrap key shorter than SEB_MIN_KEY_LENGTH=${config.seb.minKeyLength} — rotate to a longer key`);
      break;
    }
  }
}

export function requireEnv(): void {
  required("DATABASE_URL");
}
