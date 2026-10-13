import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendEnv = resolve(root, 'backend/.env');
const databaseEnv = resolve(root, '.database.env');
function run(command, args, cwd = root) {
  // Windows pnpm installs a .cmd launcher, which requires the command shell.
  // Commands and pnpm arguments below are fixed by this script.
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'pnpm' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} failed (${r.status})`);
}
function capture(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error };
}
function tcpOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolveOpen) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolveOpen(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
function parseDatabaseUrl() {
  try {
    const text = readFileSync(backendEnv, 'utf8');
    const m = text.match(/^DATABASE_URL=(.*)$/m);
    let v = (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    return v;
  } catch { return ''; }
}
function parsePassword() {
  try {
    const text = readFileSync(databaseEnv, 'utf8');
    const m = text.match(/^POSTGRES_PASSWORD=(.*)$/m);
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}
function containerState(name) {
  const exists = capture('docker', ['inspect', name]);
  if (exists.status !== 0) return 'missing';
  const running = capture('docker', ['inspect', '-f', '{{.State.Running}}', name]);
  if (running.stdout.trim() === 'true') return 'running';
  const status = capture('docker', ['inspect', '-f', '{{.State.Status}}', name]);
  return `stopped(${status.stdout.trim() || 'unknown'})`;
}
async function authenticatedQueryOk(dbUrl) {
  if (!dbUrl) return false;
  // Prefer psql when present (no new deps); fall back to pg from backend.
  const psql = spawnSync('psql', [dbUrl, '-c', 'SELECT 1'], { stdio: 'ignore', timeout: 10000 });
  if (!psql.error && psql.status === 0) return true;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(resolve(root, 'backend/package.json'));
    const { Client } = req('pg');
    const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 8000 });
    await client.connect();
    try { await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
    return true;
  } catch { return false; }
}
async function setup() {
  const dockerVersion = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (dockerVersion.error?.code === 'ENOENT') {
    throw new Error('Docker was not found. Install Docker Desktop, start it in Linux-container mode, then close and reopen VS Code before retrying pnpm setup:local.');
  }
  if (dockerVersion.error || dockerVersion.status !== 0) {
    throw new Error('Docker could not run. Check docker --version in this terminal.');
  }
  const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (dockerReady.error || dockerReady.status !== 0) {
    throw new Error('Docker is installed but its engine is unavailable. Start Docker Desktop, wait until it is running, and check docker info before retrying.');
  }
  if (!existsSync(backendEnv) && !existsSync(databaseEnv)) {
    const password = randomBytes(24).toString('hex');
    writeFileSync(databaseEnv, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=exam_platform\n`, { mode: 0o600 });
    writeFileSync(backendEnv, [
      `DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:5432/exam_platform`,
      `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
      `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
      `SEB_BOOTSTRAP_KEYS=${randomBytes(32).toString('hex')}`,
      'BETTER_AUTH_URL=http://localhost:4000',
      'FRONTEND_URL=http://localhost:4000,http://localhost:5173,http://localhost:5174',
      'PORT=4000',
      'NODE_ENV=development',
    ].join('\n') + '\n', { mode: 0o600 });
    console.log('Created private local database and auth configuration.');
  } else if (!existsSync(backendEnv) || !existsSync(databaseEnv)) {
    throw new Error('Existing configuration was preserved. Local setup requires both backend/.env and .database.env; configure the missing file first.');
  }
  if (!existsSync(databaseEnv)) {
    throw new Error('Missing .database.env (--env-file for the postgres container). Restore it before retrying.');
  }
  let useSystemDb = false;
  const state = containerState('o6u-postgres');
  if (state === 'running') {
    console.log('Reusing running o6u-postgres container.');
  } else if (state.startsWith('stopped')) {
    console.log(`Starting existing o6u-postgres container (${state})...`);
    const started = capture('docker', ['start', 'o6u-postgres']);
    if (started.status !== 0) {
      console.error(started.stderr || 'docker start failed.');
      const portBusy = await tcpOpen('127.0.0.1', 5432);
      if (portBusy) {
        console.log('Port 5432 is already in use — a system PostgreSQL is likely running.');
        console.log('Reusing system DB at 127.0.0.1:5432. To return to docker later: stop the system postgres, then `docker start o6u-postgres`.');
        useSystemDb = true;
      } else {
        throw new Error(`docker start o6u-postgres failed (${state}). Inspect docker logs o6u-postgres.`);
      }
    }
  } else {
    const r = capture('docker', ['run', '-d', '--name', 'o6u-postgres', '--restart', 'unless-stopped', '--env-file', databaseEnv,
      '-p', '127.0.0.1:5432:5432', '-v', 'o6u-postgres-data:/var/lib/postgresql/data', 'postgres:18']);
    if (r.status !== 0) {
      const out = (r.stdout + r.stderr).toLowerCase();
      const portBusy = out.includes('port is already allocated') || out.includes('address already in use') || await tcpOpen('127.0.0.1', 5432);
      if (r.status === 125 || portBusy) {
        console.log('docker run failed: port 5432 is in use (exit 125 or bind conflict).');
        console.log('A system PostgreSQL on 5432 will be reused instead of the o6u-postgres container.');
        console.log('Ensure it has database exam_platform and the postgres password from .database.env / backend/.env DATABASE_URL.');
        console.log('To use docker instead: stop the system postgres (`sudo systemctl stop postgresql` or `brew services stop postgresql`), remove the half-created container (`docker rm o6u-postgres`), and rerun pnpm setup:local.');
        useSystemDb = true;
      } else {
        if (r.stderr) console.error(r.stderr);
        throw new Error('docker run o6u-postgres failed. Inspect docker logs o6u-postgres.');
      }
    }
  }
  const dbUrl = parseDatabaseUrl();
  if (useSystemDb) {
    // System DB path: TCP must be open and credentials must authenticate.
    if (!await tcpOpen('127.0.0.1', 5432)) {
      throw new Error('System PostgreSQL fallback selected but nothing listens on 127.0.0.1:5432. Start system postgres or free the port for docker.');
    }
    if (!await authenticatedQueryOk(dbUrl)) {
      throw new Error('System PostgreSQL on 127.0.0.1:5432 reachable but DATABASE_URL authentication failed (SELECT 1). Update backend/.env DATABASE_URL / .database.env POSTGRES_PASSWORD to match the system postgres password.');
    }
    console.log('System PostgreSQL verified (authenticated SELECT 1 ok). Continuing to migrate/seed.');
  } else {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (spawnSync('docker', ['exec', 'o6u-postgres', 'pg_isready', '-U', 'postgres', '-d', 'exam_platform'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) throw new Error('PostgreSQL did not become ready. Inspect docker logs o6u-postgres.');
    // Authenticated check: pg_isready alone proves the port is open, not that
    // our password works. Fail fast here instead of mid-migration.
    if (!await authenticatedQueryOk(dbUrl)) {
      // Try the container-side check with the stored password before giving up.
      const pw = parsePassword();
      const inner = pw
        ? spawnSync('docker', ['exec', '-e', `PGPASSWORD=${pw}`, 'o6u-postgres', 'psql', '-U', 'postgres', '-d', 'exam_platform', '-c', 'SELECT 1'], { stdio: 'ignore' })
        : { status: 1 };
      if (inner.status !== 0) throw new Error('PostgreSQL is up but DATABASE_URL authentication failed. Check backend/.env DATABASE_URL matches .database.env POSTGRES_PASSWORD.');
    }
  }
  const backend = resolve(root, 'backend');
  run('pnpm', ['db:generate'], backend);
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], backend);
  run('pnpm', ['seed'], backend);
  run('pnpm', ['seed:test'], backend);
  console.log('Local database ready. Run pnpm build, then pnpm start.');

}
try {
  await setup();
} catch (error) {
  console.error('Local setup failed: ' + (error instanceof Error ? error.message : String(error)));
  console.error('Finish setup successfully before running pnpm build or pnpm start.');
  process.exitCode = 1;
}
