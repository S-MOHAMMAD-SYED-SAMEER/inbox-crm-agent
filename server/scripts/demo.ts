import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/password.ts';

// `npm run demo` (from the repository root, or from `server/` once the
// dashboard has been built)
//
// Runs the whole app locally, in one process tree: reset the demo database to
// its seeded starting state, then serve the API and the built dashboard from one
// origin. It is a wrapper over `npm run reset` and `npm start` — it adds no
// behaviour of its own to the application.
//
// WHY A SEPARATE DATABASE FILE, AND WHY RESET
//
// Every run should open on the same pristine demo — an empty inbox and the
// seeded CRM — because a walkthrough consumes that state. `reset` gives exactly
// that, and it deletes every row, so it is pointed at its own SQLite file
// (`data/demo-local.sqlite`) rather than the development one: running the demo
// can never clear data somebody was working with.
//
// WHY IT SETS THE ENVIRONMENT ITSELF
//
// The server refuses every request without a session, and by design has no
// built-in password: `OPERATOR_PASSWORD_HASH` must be supplied. A fresh clone
// has none, so rather than weaken that default this script makes a throwaway
// password for the run and prints it. It is never written to disk, and a new
// one is made each time.
//
// The rest pins the safe local posture explicitly, because a `.env` left over
// from other work must not be able to point a demo at a real database or a real
// model. A variable already set in the environment wins over `.env` (Node's
// `loadEnvFile` never overrides), so setting them here is enough:
//   - DATABASE_URL empty    → local SQLite, never a hosted database
//   - SQLITE_PATH            → the demo's own file, so a reset cannot touch dev data
//   - LLM_PROVIDER=mock      → deterministic fixtures, no key, no spend
//   - EMAIL_SOURCE=demo      → the ten fixture emails; nothing is read from a mailbox
//   - ALLOW_OUTBOUND_SEND=false → nothing is ever sent
//   - COOKIE_SECURE=false    → browsers refuse Secure cookies over http://localhost

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DATABASE = path.join(SERVER_ROOT, 'data', 'demo-local.sqlite');

const password = randomBytes(8).toString('hex');
const port = process.env.PORT?.trim() || '3100';

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: port,
  DATABASE_URL: '',
  SQLITE_PATH: DEMO_DATABASE,
  LLM_PROVIDER: 'mock',
  EMAIL_SOURCE: 'demo',
  ALLOW_OUTBOUND_SEND: 'false',
  COOKIE_SECURE: 'false',
  OPERATOR_PASSWORD_HASH: await hashPassword(password),
};

function run(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: SERVER_ROOT, env, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const resetCode = await run('scripts/reset.ts');
if (resetCode !== 0) process.exit(resetCode);

console.log(`\n[demo] Open http://localhost:${port}`);
console.log(`[demo] Sign in with this password (made for this run, local only): ${password}\n`);

process.exit(await run('src/index.ts'));
