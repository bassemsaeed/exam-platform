# Run the connected O6U examination portal

This workspace runs the full O6U frontend with real Better Auth authentication and API workflows against PostgreSQL 18. The frontend and API share `http://localhost:4000`; the hosted Sites URL remains the separately labeled UI demo.

## Setup and start

Requires Node 26 (the repository target), pnpm, and a running Docker daemon. On Windows, install Docker Desktop, use Linux containers, and wait for its engine to start. PowerShell is supported by the updated setup script; WSL is also supported. After installing Docker, reopen VS Code so its terminal receives the updated PATH. Run each command separately and continue only if it succeeds.

```sh
pnpm install
pnpm setup:local
pnpm build
pnpm start
```

`setup:local` creates random private credentials in ignored `.database.env` and `backend/.env`, starts the persistent `o6u-postgres` container, generates Prisma, applies migrations, and runs the non-destructive development seeds. It preserves existing configuration and database data. The Postgres port is bound to loopback only; its data lives in the `o6u-postgres-data` Docker volume. It does not run the destructive `seed:exams` command.

Open `http://localhost:4000` **inside this workspace**. A remote workspace’s localhost is not the localhost on your own computer; use workspace port forwarding for port 4000 if available. No public backend deployment is configured.

Development accounts:

| Role | Username | Password |
| --- | --- | --- |
| Student | `stu1` | `Password123` |
| Educator | `doc1` | `Password123` |
| Teaching assistant | `ta1` | `Password123` |
| Admin | `admin1` | `Password123` |

These are the repository’s development accounts, not university accounts. Use only in local development. Demo preview mode is off in the connected application.

## Development

`pnpm dev` starts Express on port 4000 and Vite on port 5173. Vite forwards `/api` and `/uploads` to Express; an empty `VITE_API_URL` makes requests to the current browser origin. Keep `VITE_PREVIEW_MODE` unset. Real sessions use HttpOnly cookies; successful login is verified by `/api/v1/me`, and logout revokes the server session.

## Verification

With the app running:

```sh
pnpm test:login
```

The test uses real HTTP requests and real seeded database users, without mocks. It verifies all four roles, case normalization, invalid password rejection, HttpOnly session cookies, session restoration after reload, logout, no demo UI, mobile layout, and browser errors. It uses system Chromium when available; otherwise install it with `pnpm exec playwright install chromium`, or set `CHROMIUM_EXECUTABLE_PATH`.

Health: `/api/v1/health`. Database readiness: `/api/v1/ready`. Unknown `/api` paths return errors rather than frontend HTML.

## Restart and stop

Stop the app process with Ctrl+C. Stop PostgreSQL with `docker stop o6u-postgres`; restart with `docker start o6u-postgres`. Start the application again with `pnpm start`. Do not remove the Docker volume unless you intend to delete development data.

For a permanent deployment, use a Node host and PostgreSQL with HTTPS, private production credentials, the correct `BETTER_AUTH_URL` and `FRONTEND_URL`, and provisioned accounts. The current frontend-only hosted preview has not been connected to this temporary workspace server.

## Full interface

The login opens the role-specific dashboard. The hosted demo offers a role selector; real accounts use their server-assigned role. See frontend/README.md for implemented workflows, data-state architecture, and end-to-end verification commands. Real student exams preserve Safe Exam Browser enforcement. The hosted URL uses browser-local sample data, while http://localhost:4000 serves the real workspace application.

The added support queue and notification read receipts require the additive `20261006160000_portal_support` migration. `pnpm setup:local` applies it without resetting the existing database. Public support requests are reviewed inside the portal; no email delivery service is configured. The hosted preview remains a browser-local demo.

## Setup troubleshooting

- `spawnSync docker ENOENT`: Docker is missing from the terminal PATH. Install/start Docker Desktop, reopen VS Code, and verify `docker --version` and `docker info`.
- Docker engine unavailable: wait for Docker Desktop to start and use Linux containers.
- Missing `generated/prisma/client.js` or cascading TypeScript errors: finish `pnpm setup:local` first. The backend build also generates Prisma automatically.
- After a failed setup, keep both private `.database.env` and `backend/.env` files together and retry; configuration is preserved.
- Do not run build/start after setup fails.
