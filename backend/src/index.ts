import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { auth } from "./lib/auth.js";
import { config } from "./lib/config.js";
import { mayChangePassword } from "./lib/domain.js";
import { prisma } from "./lib/prisma.js";
import { startBackgroundWorker } from "./lib/worker.js";
import { Prisma } from "./generated/prisma/client.js";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { adminAudit } from "./routes/adminAudit.js";
import { adminAssignments } from "./routes/adminAssignments.js";
import { adminDepartments } from "./routes/adminDepartments.js";
import { adminExams } from "./routes/adminExams.js";
import { adminExports } from "./routes/adminExports.js";
import { adminImports } from "./routes/adminImports.js";
import { adminPermissions } from "./routes/adminPermissions.js";
import { adminSebKeys } from "./routes/adminSebKeys.js";
import { adminSections } from "./routes/adminSections.js";
import { adminSubjects } from "./routes/adminSubjects.js";
import { adminTerms } from "./routes/adminTerms.js";
import { adminUsers } from "./routes/adminUsers.js";
import { exams } from "./routes/exams.js";
import { exportsJobs } from "./routes/exports.js";
import { health } from "./routes/health.js";
import { isLocalStorage, localUploadsDir } from "./lib/storage.js";
import { questionBank } from "./routes/questionBank.js";
import { student } from "./routes/student.js";

const app = express();
// Behind TLS-terminating proxies (nginx/Caddy/LB) so req.protocol/host match
// what SEB hashed. TRUSTED_PROXY_IPS pins WHICH peers may supply X-Forwarded-
// For (default: loopback only); anything else and a client can rotate the
// header to dodge IP-keyed buckets. Production: set it to the LB IPs/CIDRs.
app.set("trust proxy", config.proxyTrust);

app.use(
  cors({
    origin: config.frontendOrigins,
    credentials: true,
    // Custom headers the frontend must read (idempotent replays) need an
    // explicit CORS whitelist or the browser hides them from fetch.
    exposedHeaders: ["Idempotent-Replay"],
  }),
);

// Better Auth handler FIRST — before express.json() (it parses the body itself).
// Express v5: wildcard needs named syntax /{*any}.
app.all(
  "/api/auth/{*any}",
  rateLimit(config.authRateLimit.max, config.authRateLimit.windowMs),
  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Match on the normalized path: guards must not depend on trailing-slash
    // or casing quirks that the downstream handler may still accept.
    const p = req.path.replace(/\/+$/, "").toLowerCase();
    // Excel import / admin own identity: public self-registration would bypass
    // enrollment entirely (defense in depth alongside disableSignUp).
    if (p.endsWith("/sign-up/email") || p.endsWith("/sign-up/username")) {
      return res.status(403).json({ error: "registration by admin only" });
    }
    // Self-service identity mutation is admin-owned: profile/email changes and
    // account deletion would bypass the "admin owns identity" model (the app
    // never calls these — sign-out and session self-read stay allowed).
    if (p.endsWith("/delete-user") || p.endsWith("/update-user") || p.endsWith("/change-email")) {
      return res.status(403).json({ error: "managed by admin" });
    }
    // Native change-password would bypass the student gate (spec §2.2), which
    // lives on the /student wrapper — enforce it here for both paths.
    if (p.endsWith("/change-password")) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
      const me = session?.user ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, canChangePassword: true, isActive: true } }) : null;
      if (!me || !me.isActive || !mayChangePassword(me.role, me.canChangePassword)) {
        return res.status(403).json({ error: "password managed by admin" });
      }
    }
    next();
  },
  toNodeHandler(auth),
);

app.use(express.json({ limit: config.bodyLimit }));

app.use("/api/v1", health);
// Session truth for all roles (goes through requireAuth, so disabled
// accounts 403 here even though Better Auth's own get-session still mints).
// The frontend polls this for realtime logout after an admin disable.
app.get("/api/v1/me", requireAuth, async (req: express.Request, res: express.Response) => {
  const a = req as unknown as AuthedRequest;
  const me = await prisma.user.findUnique({
    where: { id: a.userId },
    select: { id: true, username: true, name: true, email: true, role: true, canChangePassword: true, isActive: true },
  });
  if (!me) return res.status(401).json({ error: "unauthenticated" });
  res.json(me);
});
app.use("/api/v1/admin/users", adminUsers);
app.use("/api/v1/admin/subjects", adminSubjects);
app.use("/api/v1/admin/sections", adminSections);
app.use("/api/v1/admin/departments", adminDepartments);
app.use("/api/v1/admin/assignments", adminAssignments);
app.use("/api/v1/admin/terms", adminTerms);
app.use("/api/v1/admin/permissions", adminPermissions);
app.use("/api/v1/admin/exams", adminExams);
app.use("/api/v1/admin/users/import", adminImports);
app.use("/api/v1/admin/seb-keys", adminSebKeys);
app.use("/api/v1/admin/audit", adminAudit);
app.use("/api/v1/admin/exports", adminExports);
app.use("/api/v1/question-bank", questionBank);
app.use("/api/v1/exams", exams);
app.use("/api/v1/exports", exportsJobs);
app.use("/api/v1/student", student);

// Local-disk image serving (single-server dev only). S3 mode needs no route.
// Auth-gated (V-04): question diagrams must never be anonymously fetchable by
// guessing /uploads/questions/<code>/<hash>-*.png. Any logged-in user may
// load them (students need them mid-exam); outsiders get 401 before static.
// nosniff: stored files must never be MIME-sniffed into scripts.
if (isLocalStorage()) {
  app.use("/uploads", requireAuth, express.static(localUploadsDir(), {
    maxAge: "1h",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  }));
}

// Feature routers follow the same pattern: Router + requireAuth + Zod + auditLog.

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "validation", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: "conflict", target: err.meta?.target });
    if (err.code === "P2025") return res.status(404).json({ error: "not found" });
    if (err.code === "P2003") return res.status(400).json({ error: "invalid reference", field: err.meta?.field_name });
    if (err.code === "P2023" || err.code === "P2007") return res.status(400).json({ error: "malformed id" });
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ error: "malformed id" });
  }
  console.error(err);
  res.status(500).json({ error: "internal" });
});

const server = app.listen(config.port, () => console.log(`backend on :${config.port}`));

// In-process background worker: export jobs + expiry sweeper. Single-server
// MVP; multi-server needs a distributed lock / job queue (same interface).
startBackgroundWorker();

// Graceful shutdown: stop accepting first so in-flight submits finish, then
// disconnect the pool. (Previously: immediate disconnect+exit dropped them.)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
    // Hung connections must not block shutdown forever.
    setTimeout(() => void prisma.$disconnect().finally(() => process.exit(0)), 10_000).unref();
  });
}
