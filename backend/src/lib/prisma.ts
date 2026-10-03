import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { config, requireEnv } from "./config.js";

requireEnv();

// Pooling for 5k concurrent + multi-server:
// - One PrismaClient per process (never per request).
// - Small per-process pool; scale with PgBouncer in transaction
//   mode in front of Postgres when running N app servers, NOT by raising max.
// - statement_timeout kills runaway export/analytics queries instead of
//   letting them pile up behind exam traffic.
const adapter = new PrismaPg({
  connectionString: config.databaseUrl,
  // Pin the session timezone to UTC. The driver binds timestamptz params as
  // naive wall digits, so a non-UTC session (e.g. server TZ Africa/Cairo)
  // stores every app-written instant shifted by the offset (-3h observed):
  // the UI then shows hours of remaining time while the raw-SQL sweeper
  // (which uses the true DB NOW()) auto-submits instantly. UTC sessions make
  // naive binds, reads, and NOW() agree. If a PgBouncer front ever strips the
  // `options` startup parameter, set the *server* TimeZone to UTC instead.
  options: "-c TimeZone=UTC",
  max: config.pool.max,
  idleTimeoutMillis: config.pool.idleMs,
  connectionTimeoutMillis: config.pool.connectMs,
  statement_timeout: config.pool.statementMs,
  application_name: "exam-platform",
});

// Reuse across hot reloads (tsx watch) to avoid exhausting pg pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// DB clock: expiry decisions in the student runtime compare against this, not
// Date.now(). App and DB clocks can skew (NTP, containers); the sweeper
// already uses SQL NOW(), so request paths must too or the two disagree on
// expiry and submittedAt ordering becomes unreliable.
export async function dbNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<{ now: Date }[]>`SELECT NOW() as now`;
  return rows[0].now;
}

// Graceful shutdown lives in index.ts (it owns the HTTP server and must drain
// it before disconnecting). No process handlers here: registering them per
// import leaks listeners on hot reload and kills in-flight submits.
