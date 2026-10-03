# Frontend — API-client starter

Minimal Vite + React app containing only what a frontend needs to talk to
`backend/`. Build your own pages on top; nothing else here is required.

## What's inside

- `src/lib/auth-client.ts` — Better Auth client. Must mirror the server:
  `usernameClient({ displayUsername: false })`, `baseURL = VITE_API_URL`.
- `src/lib/api.ts` — typed `fetch` wrapper (cookie session) + `api` object:
  `getSession` (via `GET /api/v1/me`), `signIn` (username, lowercased),
  `signOut`, `get/post/patch/delete`, `upload` (FormData).
- `src/lib/query.ts` — TanStack Query client (single server cache, no
  focus-refetch) + `useSessionUser()` (polls `/me` every 20s for realtime
  disable-kick) + `refreshSession()`.
- `src/lib/session.ts` — zustand auth mirror + toast store + `homeFor` role
  routes; `evictSession()` on 401/disabled-403.
- `src/lib/seb.ts` — SEB header minter for exam endpoints (dev only).
- `src/App.tsx` — demo: sign-in form + session view. Replace with your app.

## Setup

```sh
pnpm install
cp .env.example .env   # VITE_API_URL=http://localhost:4000
pnpm dev               # :5173
```

`pnpm build` runs `tsc -b && vite build`.

## Env

| Var                | Meaning |
| ------------------ | ------- |
| `VITE_API_URL`     | Backend base URL (Express, not the Vite server). |
| `VITE_SEB_DEV_KEY` | Dev-only raw SEB key so a plain browser can mint `X-SafeExamBrowser-RequestHash` for SEB-gated endpoints. Must match an active `seb_key` row (see `backend` `seed:test`). **Never set in production** — the build throws if it is present. |

## Usage

```tsx
import { api } from "./lib/api";
import { useSessionUser } from "./lib/query";
import { sebHeaders } from "./lib/seb";

// Login
const r = await api.signIn(username, password);
if (r.error) { /* show r.error.message */ }

// Authenticated call (cookies included)
const me = await api.getSession();

// SEB-gated endpoint (student exam runtime)
const headers = await sebHeaders(`/api/v1/student/exams/${id}/start`);
const exam = await api.post(`/api/v1/student/exams/${id}/start`, {}, headers);
```

## Rules

- Keep `better-auth` at the same version as the backend (`1.7.7`).
- Session truth is `api.getSession()` (`GET /api/v1/me`), which rejects
  disabled accounts. Do not rely on Better Auth's raw `get-session`.
- Never import `PrismaClient` (or backend code) here — the UI contract is
  the small DTOs in `lib/api.ts` (`SessionUser`, `Role`).
- For SSE streams use `fetch` + `ReadableStream`, not `EventSource`
  (the SEB header must be sent on the request).
