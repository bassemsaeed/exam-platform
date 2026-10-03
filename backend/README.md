# Backend — exam platform API

Express 5 + Prisma 7 + Better Auth (username login) + Postgres.

## Setup

```sh
pnpm install
cp .env.example .env   # fill in DATABASE_URL, BETTER_AUTH_SECRET (32+ chars),
                       # FRONTEND_URL, SEB_BOOTSTRAP_KEYS, ENCRYPTION_KEY
pnpm db:generate
pnpm db:migrate        # dev database; production/CI: `prisma migrate deploy`
```

Boot: `pnpm dev` (`:4000`). Production: `pnpm build` then `pnpm start`.
Studio: `pnpm db:studio`.

## Seeds (run in this order)

| Command            | What it does |
| ------------------ | ------------ |
| `pnpm seed`        | Permission defaults matrix, current term, SEB bootstrap keys. Rerunnable (upserts). Run once. |
| `pnpm seed:test`   | Demo data: 3 admins, 4 doctors, 4 TAs, 8 students (password `Password123`), CS dept + CS301, sections A–D with rosters, a doctor bank (12) + a shared TA bank (6), dev SEB lab key. Requires `seed` first. Rerunnable (skips existing). Refuses `NODE_ENV=production` unless `ALLOW_SEED_TEST_DATA=true`. |
| `pnpm seed:exams`  | Exam matrix: open live exam, coded live exam (code `123456`), Section-A quiz, pending approval, rejected, past graded exams + one live seat. **Wipes the current term's exams first** (sittings/events/compensations cascade; other terms untouched). Refuses `NODE_ENV=production` unless `ALLOW_DESTRUCTIVE_SEED=true`. |

Safety notes: exactly one current term is enforced by the database (partial
unique index); `make-current` and `seed` clear-then-set atomically. Term wipe
refuses non-current terms (double-gated by `confirm:true`), live sittings,
and removes the wiped jobs' files. Deleting a user with graded sittings is
refused at the DB level — disable instead.

## API map

- `ALL /api/auth/*` — Better Auth handler (mounted before `express.json()`).
  Self-registration (`/sign-up/*`) is rejected: users are admin-created.
- `GET /api/v1/me` — session truth for all roles (disabled accounts 403).
- `GET /api/v1/health`, `GET /api/v1/ready` — liveness / DB readiness.
- `GET/PATCH /admin/*` — admin console (users, subjects, sections, terms,
  departments, assignments, permissions, exams approvals, imports, SEB keys,
  audit, exports monitor). All Zod-validated, paginated, audit-logged.
- `/*` staff — question banks, exams/quizzes, grouped results, scoped exports.
- `/student/*` — profile, available exams, exam runtime
  (start/answer/flag/heartbeat/submit), SSE events, results. SEB-gated where
  required via `X-SafeExamBrowser-RequestHash`.
- `POST /api/v1/exports` + `GET /:id(/download)` — async CSV exports
  (cursor-paged worker; `?sync=1` inline fallback capped).

All routers return `{ rows, page, limit, total }` envelopes (or a single
object); errors are `{ error }` with Zod→400, conflict→409, missing→404.

## Notes

- Single source of truth for tunables: `src/lib/config.ts` (fails fast at
  boot on bad/missing env — see `.env.example`); roles/permissions:
  `src/lib/domain.ts`.
- Timezone: Postgres sessions are pinned to UTC (`-c TimeZone=UTC`); keep
  server TZ at UTC (also required behind PgBouncer).
- Multi-server later: set `REDIS_URL` (rate-limit + SSE fan-out),
  `S3_ENDPOINT` + bucket keys (images/exports), and run PgBouncer.
