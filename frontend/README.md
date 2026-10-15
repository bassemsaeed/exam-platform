# O6U Examination Portal

React 19 + TypeScript frontend for the repository’s Express/Prisma/Better Auth API. Uses the official O6U logo and a minimal navy, white, and orange visual system.

## Workspaces

- Students: available exams, entry codes, timed runner, answer saving with serialized writes and retry feedback, flags, reload/resume, final submission, grades, account settings.
- Educators/TAs: exam/quiz creation with audience and difficulty or manual blueprints, question CRUD and images, spreadsheet imports, grouped results, export jobs.
- Admins: exam approval/rejection, editable settings, entry codes, live sittings, announcements, compensation, users, password resets, session revocation, permissions, subjects, departments, sections/rosters, educator assignments, student enrollments, academic terms, SEB key registration/activation, audit log.

The backend remains authoritative for roles, per-user permission overrides, protected records, scheduling, grading, targeting, and Safe Exam Browser requirements. Rejected changes show API error details. Sensitive term wipes are not exposed as an ordinary UI action.

## State management

TanStack Query owns API data using keys scoped to the authenticated user and endpoint. Queries use 30-second freshness, 5-minute garbage collection, cancellation signals, and pagination. Previous data is retained only when the base endpoint matches. Mutations invalidate dependent endpoint caches. Login/logout and revoked sessions clear user-specific caches. Focus refetch is disabled to protect active exam views.

Zustand persists only display preferences. Real passwords, exam answers, and session identities are never persisted in browser storage. The runner holds an active server-provided snapshot, serializes answer saves, blocks normal submission while saves are pending/failed, and uses the server heartbeat to correct its timer. Submissions use a stable idempotency key per mounted attempt. Authenticated SSE reconnects with the last event cursor and cleans up on unmount.

## Running against the real backend

See [LOCAL_SETUP.md](../LOCAL_SETUP.md). The default API origin is the browser origin. Vite proxies `/api` and `/uploads`; Express serves the built frontend for same-origin cookies. Configure `VITE_API_URL` only for a separate API host. Real mode uses browser-history routes with Express’s SPA fallback.

Safe Exam Browser is required for student exam listing/runtime. Production builds refuse `VITE_SEB_DEV_KEY`. For development exam verification only, use the known seeded lab key in a dev Vite server and add that dev origin to backend `FRONTEND_URL`. Do not bundle a lab key into production assets.

## Hosted demo

`VITE_PREVIEW_MODE=true` enables the explicitly labeled browser-local sample adapter. Login: `alex.morgan` / `Preview123!`. Use the credential-fill button, then switch among the four roles in the header. Demo records and attempts persist on this device; Reset demo restores sample data. The demo uses hash routes so nested pages can be reloaded on static hosting.

Demo grade calculations, CRUD, approvals, and CSV exports work locally. Spreadsheet/image uploads require the connected backend and show that requirement. No real university accounts, grades, or files are touched. The existing hosted preview remains private and is separate from the workspace’s real backend.

## Checks

- `pnpm build`: TypeScript + both production builds.
- `pnpm test:login`: real login/session/logout checks for four roles at port 4000.
- `pnpm test:platform`: demo end-to-end workflow checks; run a demo Vite server on port 5180 first.
- `pnpm test:workflows`: real educator/admin CRUD/approval checks. Creates and cleans up verification records.
- `pnpm test:exam`: real student exam attempt using `stu8` at a development server on port 5181 with the seeded development SEB key. This submits that development attempt, so use a fresh development dataset or another enrolled test account for reruns.

## Display preferences

The login header and portal header offer English/Arabic and System/Light/Dark controls. Arabic sets the document language and RTL direction, localizes interface labels, statuses, dialogs, and dates, and uses an Arabic font with a local fallback. University records, question content, answer choices, credentials, and API payloads remain in their original language and values.

Preferences extend the existing `o6u-ui-preferences` Zustand store and persist independently of login. Switching language or theme does not remount routes, reset forms, clear server caches, or alter active attempts. System mode follows live OS appearance changes.

Run `pnpm test:preferences` with the demo dev server on port 5180 for Arabic login/admin/student flows, RTL mobile layout, form and answer preservation, system theme updates, and preference persistence.

## Account support and notifications

Login help explains account provisioning and accepts access/reset requests. Real requests are stored in PostgreSQL; administrators review them under Account requests. A public request never looks up an account, establishes identity, sends an email, or resets a password. Responses are generic and rate-limited. Administrators verify identity through existing faculty records and use the existing protected account controls. Requests carry an internal follow-up note and a resolved/closed status.

The inbox derives notices from authorized current-term schedules, submitted results, creator-owned assessment decisions, pending admin approvals, and account requests. Schedule notices contain metadata only, never questions or secret hashes. Read receipts are user-scoped in PostgreSQL. The demo adapter stores sample requests/receipts on the device and says so explicitly.

Exam preflight is read-only and validates the same role, permission, Safe Exam Browser, enrollment, and audience gates as starting. Resumes preserve existing-attempt eligibility behavior. Starting a new attempt requires acknowledgement of the timer and submission rules. Preflight does not start a timer or expose questions.

Admin user filters use the existing server API. Bulk activation/deactivation operates on explicitly selected non-admin accounts from the current page, shows a confirmation and individual results, and calls the existing protected/audited single-account update endpoint. Filter and page changes clear selection. Deactivation retains the existing session revocation behavior.

Accessibility updates include larger supporting text, improved contrast, visible keyboard focus, a skip link, dialog headings, table column scopes, associated field hints, reduced-motion support, and an inert off-screen mobile menu with Escape-to-close. English and Arabic are both supported.

- `pnpm test:additions`: demo support, notifications, filters, bulk actions, preflight, resume, Arabic/dark/mobile keyboard checks.
- `pnpm test:real-additions`: real persisted requests/receipts, role and SEB gates, and bulk account updates with account state restored afterward.

## Demo password behavior

The single preview sign-in account (`alex.morgan`) uses `Preview123!` until changed. Profile changes verify the current password, then persist a salted PBKDF2 verifier on this device; login reads that same verifier. Passwords are never stored in plaintext. The preview role selector still shares this one demo sign-in account. Resetting Alex’s password in the demo admin UI updates the same verifier. Reset demo or the explicit reset button on the login screen restores the original credentials. The credential-fill button stops filling the original password after a change.

The real application continues to use Better Auth and PostgreSQL; demo credentials never participate in real API authentication. `pnpm test:password` checks wrong-current-password rejection, logout/reload persistence, old/new login behavior, administrator reset, and restoring demo defaults. It also verifies and restores the seeded `doc4` password against the real backend.

## Exam experience

The student exam route hides portal navigation, notifications, account controls, logout, and the footer. Only the light/dark theme toggle remains in the header. Once started, the attempt pins in-app navigation to its exam route until submission or a terminal start response. Browser refresh still requires resuming the attempt; server time continues while disconnected.

Each page contains up to four questions. The final page has a Submit assessment button, and every manual submission requires confirmation. All questions must be answered and answer saves completed before manual submission; expiry still auto-submits partial attempts.

A basic calculator is available inside the runner. Creators can enable private, ungraded scratch notes and set the maximum number of re-entries before the exam opens. Notes default to disabled; re-entries default to three, excluding the initial entry. Each refreshed or newly loaded exam page uses a fresh entry token; repeated start requests from the same mounted page reuse their token. Heartbeat and announcement reconnections do not consume entries. PostgreSQL enforces the cap atomically, including concurrent requests. Notes autosave to the server and keep a tab-local recovery copy while editing.

The question bank requires selecting a subject in the top filter before fetching questions. Images can be attached while creating or editing questions. The existing raster-image upload endpoint validates file contents. If image upload fails after question creation, retry reuses the created question ID.

Apply backend migrations before running this version: `pnpm --filter backend exec prisma migrate deploy`.

Verification: `pnpm test:exam-experience` runs browser checks with mocked API responses against `FRONTEND_URL` (default `http://127.0.0.1:5189`). Set `CHROMIUM_EXECUTABLE_PATH` if necessary. After building the backend and starting a local seeded API, `pnpm --filter backend test:exam-experience` checks re-entry limits, concurrent admission, and note enforcement against PostgreSQL using temporary records that it removes afterward.
