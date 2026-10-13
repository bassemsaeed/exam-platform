# Exam Platform

University exam platform: an Express + Prisma + Better Auth API (`backend/`)
with a minimal Vite + React API-client starter (`frontend/`). Build any
frontend on top of the contract in `frontend/src/lib/`.

## Layout

- `backend/` — REST API: auth (username login), users, subjects, sections,
  terms, question banks, exams/quizzes, student exam runtime (start/answer/
  heartbeat/submit + SSE), exports, audit, SEB keys. See `backend/README.md`.
- `frontend/` — fresh-Vite-style starter with only the backend contract:
  auth client, typed fetch wrapper, session cache, SEB helper, and a demo
  login page. See `frontend/README.md`.

## Prerequisites

- Node 26, pnpm 12.8.1, Postgres 18.

## Quickstart

```sh
pnpm install

# Backend config
cp backend/.env.example backend/.env
# edit backend/.env: DATABASE_URL, BETTER_AUTH_SECRET (32+ chars),
# FRONTEND_URL, SEB_BOOTSTRAP_KEYS, ENCRYPTION_KEY

pnpm --filter backend db:generate
pnpm --filter backend db:migrate        # dev; production uses `prisma migrate deploy`

# Seed in order: base -> demo data -> test exams
pnpm --filter backend seed
pnpm --filter backend seed:test
pnpm --filter backend seed:exams        # wipes and rebuilds exams only

# Frontend config
cp frontend/.env.example frontend/.env  # VITE_API_URL=http://localhost:4000

pnpm --filter backend dev               # :4000
pnpm --filter frontend dev              # :5173
```

Health: `GET /api/v1/health` → `{"ok":true}`,
`GET /api/v1/ready` → `{"ok":true,"db":true}`.

## Rules

- `better-auth` client and server must stay on the same version (`1.7.7`).
- Session truth is `GET /api/v1/me`, not Better Auth's raw `get-session`.
- Never import `PrismaClient` in the browser — the frontend owns small
  explicit DTOs (`SessionUser`, `Role`).
- Public sign-up is disabled by design; users are created by admins/import.
- `VITE_SEB_DEV_KEY` is dev-only. Production builds throw if it is set.
