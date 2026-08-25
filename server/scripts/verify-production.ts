import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/password.ts';

// M7-B — production build verification.
//
// M7-A proved the wiring with `createApp` called in-process and a synthetic
// `dist/` written by the test. That is the right shape for a unit test and it
// leaves three things unproven, all of which are exactly what breaks on a first
// deploy:
//
//   1. The REAL build output. A fixture index.html cannot show that Vite's
//      hashed asset names, its base path and its content types line up with
//      what `express.static` serves.
//   2. The REAL entry point. `src/index.ts` — config from the environment,
//      `createDatabase`, the migration check, binding a port, shutting down —
//      is never executed by the test suite, which builds the app directly.
//   3. Production CONFIGURATION. `COOKIE_SECURE=true` and `TRUST_PROXY` are
//      read at startup from the environment, so the only way to know they
//      resolve correctly is to start a process with them set.
//
// So this spawns the actual server the way a host will: `node src/index.ts`,
// environment only, real build, real bootstrap. Nothing is mocked.
//
// SAFETY: THIS MUST NEVER TOUCH THE PRODUCTION DATABASE
//
// A developer machine may have a .env holding a real DATABASE_URL, and
// `config/env.ts` calls `process.loadEnvFile()` at module load. Node gives an
// explicitly-set variable precedence over the file — including one set to the
// empty string — so every child below is spawned with DATABASE_URL='' and a
// throwaway SQLite path. That is the mechanism; the guarantee is the assertion
// right after startup, which aborts the whole run if health ever reports
// anything but sqlite.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const WEB_DIST = path.resolve(SERVER_ROOT, '..', 'web', 'dist');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.ts');

const OPERATOR_PASSWORD = 'm7b-production-check-9f3a';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`    PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`    FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function fatal(message: string): never {
  console.error(`\n  ABORT: ${message}\n`);
  process.exit(1);
}

// --- a browser, with a cookie jar -------------------------------------------

type Reply = { status: number; headers: Headers; text: string; json: unknown };

class Browser {
  private readonly jar = new Map<string, string>();
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  get csrf(): string | null {
    const raw = this.jar.get('inbox_csrf');
    return raw ? decodeURIComponent(raw) : null;
  }

  get hasSession(): boolean {
    return this.jar.has('inbox_session');
  }

  private absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] as string;
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async call(
    pathname: string,
    init: { method?: string; body?: unknown; csrf?: boolean; forwardedFor?: string } = {},
  ): Promise<Reply> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    const cookies = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookies) headers.cookie = cookies;
    // Exactly what the web client does, unless a probe deliberately omits it.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && this.csrf && init.csrf !== false) {
      headers['x-csrf-token'] = this.csrf;
    }
    if (init.forwardedFor) headers['x-forwarded-for'] = init.forwardedFor;

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    this.absorb(response);

    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — that is itself something several checks assert about */
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /** The raw Set-Cookie lines from a sign-in, for inspecting cookie attributes. */
  async loginRaw(password: string): Promise<{ status: number; setCookie: string[] }> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const setCookie = response.headers.getSetCookie();
    this.absorb(response);
    await response.text();
    return { status: response.status, setCookie };
  }
}

// --- spawning the real server ------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Started = { baseUrl: string; stop(): Promise<void>; stderr: string[] };

async function startServer(env: Record<string, string>): Promise<Started> {
  const port = await freePort();
  const stderr: string[] = [];

  const child: ChildProcess = spawn(process.execPath, [ENTRY], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      // Pinned to a throwaway SQLite file. See the safety note at the top:
      // an explicit empty value beats anything in a local .env.
      DATABASE_URL: '',
      LOG_LEVEL: 'error',
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;

  // Poll until it answers, rather than sleeping a guessed interval.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      fatal(`the server exited during startup with code ${child.exitCode}\n${stderr.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) fatal(`the server did not start within 30s\n${stderr.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    baseUrl,
    stderr,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000).unref();
      }),
  };
}

/**
 * The guard that keeps this script away from a real database.
 *
 * Runs immediately after every start. If a local .env ever wins, or the
 * pinning above is changed, the run stops here rather than continuing to write
 * to whatever it actually connected to.
 */
async function assertThrowawayDatabase(baseUrl: string): Promise<void> {
  const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
    database: { driver: string };
  };
  if (health.database.driver !== 'sqlite') {
    fatal(`health reports a "${health.database.driver}" database; this script must never run against a real one`);
  }
}

// ============================================================================

console.log('M7-B — production build verification');
console.log('='.repeat(60));

// --- 1. the real build must exist -------------------------------------------

section('1. The production build');
{
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    fatal(`no build found at ${WEB_DIST}. Run \`npm run build\` in inbox-crm-agent/web first.`);
  }

  const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
  const js = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0] ?? '';
  const css = html.match(/\/assets\/[A-Za-z0-9._-]+\.css/)?.[0] ?? '';

  check('index.html exists and mounts the app', /<div id="root">/.test(html));
  check('it references a hashed JS bundle', /-[A-Za-z0-9_-]{6,}\.js$/.test(js), js || 'none referenced');
  check('it references a hashed stylesheet', /-[A-Za-z0-9_-]{6,}\.css$/.test(css), css || 'none referenced');

  const jsPath = path.join(WEB_DIST, js.replace(/^\//, ''));
  const cssPath = path.join(WEB_DIST, css.replace(/^\//, ''));
  check('the referenced JS actually exists on disk', fs.existsSync(jsPath));
  check('the referenced CSS actually exists on disk', fs.existsSync(cssPath));
  check(
    'the bundle is a real application, not a stub',
    fs.existsSync(jsPath) && fs.statSync(jsPath).size > 100_000,
    fs.existsSync(jsPath) ? `${fs.statSync(jsPath).size} bytes` : 'missing',
  );
}

// --- 2. what the browser is shipped -----------------------------------------

section('2. The shipped bundle carries no secret and no hardcoded host');
{
  const files = fs
    .readdirSync(path.join(WEB_DIST, 'assets'))
    .map((name) => fs.readFileSync(path.join(WEB_DIST, 'assets', name), 'utf8'));
  files.push(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'));
  const bundle = files.join('\n');

  const secretShaped =
    /sk-ant-[A-Za-z0-9]{6,}|postgres(?:ql)?:\/\/[^\s"']*:[^\s"']*@|scrypt\$\d+\$|OPERATOR_PASSWORD_HASH|ANTHROPIC_API_KEY/;
  check('no secret-shaped string is shipped to the browser', !secretShaped.test(bundle));

  // The client must address the API relatively. A baked-in host is the single
  // most common way a working local build becomes a broken deploy.
  const absoluteApi = bundle.match(/https?:\/\/[a-zA-Z0-9.:-]+\/api/);
  check('no absolute API host is baked into the bundle', absoluteApi === null, absoluteApi?.[0] ?? '');

  const localhost = bundle.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/);
  check('no localhost URL survives into the build', localhost === null, localhost?.[0] ?? '');

  // The minifier rewrites `const BASE_URL = '/api'` as a template literal, so
  // the quote style cannot be assumed — only that the path appears as a bare
  // relative string somewhere in the bundle.
  check('the client addresses the API relatively', /['"`]\/api['"`]/.test(bundle));
}

// --- 3. a throwaway database -------------------------------------------------

section('3. A throwaway database, migrated and seeded');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm7b-'));
const sqlitePath = path.join(workDir, 'production-check.sqlite');
const operatorHash = await hashPassword(OPERATOR_PASSWORD);

{
  for (const script of ['migrate.ts', 'seed.ts']) {
    const result = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'scripts', script)], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: '', SQLITE_PATH: sqlitePath, LOG_LEVEL: 'error' },
      encoding: 'utf8',
    });
    check(`${script.replace('.ts', '')} ran against the throwaway database`, result.status === 0, result.stderr?.slice(0, 200));
  }
  check('the database file was created outside the repository', fs.existsSync(sqlitePath) && !sqlitePath.includes('inbox-crm-agent'));
}

const PROD_ENV = {
  SQLITE_PATH: sqlitePath,
  OPERATOR_PASSWORD_HASH: operatorHash,
  // Production values. Secure cookies are asserted by attribute below rather
  // than by TLS: this harness speaks HTTP, and what matters is that the server
  // emits the attribute a browser would then enforce.
  COOKIE_SECURE: 'true',
  TRUST_PROXY: '0',
};

// --- 4. one process serves both halves --------------------------------------

section('4. One process serves the API and the built front end');
const main = await startServer(PROD_ENV);
await assertThrowawayDatabase(main.baseUrl);
{
  const browser = new Browser(main.baseUrl);

  const health = await browser.call('/api/health');
  check('GET /api/health answers JSON', health.status === 200 && /application\/json/.test(health.headers.get('content-type') ?? ''));
  check('it reports the throwaway database, never a real one', (health.json as { database: { driver: string } }).database.driver === 'sqlite');
  check('outbound sending is off in this configuration', (health.json as { adapters: Record<string, unknown> }).adapters.outboundSendEnabled === false);
  check('sign-in is configured', (health.json as { adapters: Record<string, unknown> }).adapters.authConfigured === true);

  const root = await browser.call('/');
  const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
  check('GET / returns HTML', root.status === 200 && /text\/html/.test(root.headers.get('content-type') ?? ''));
  check('and it is byte-for-byte the built index.html', root.text === html);

  const jsRef = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0] ?? '';
  const cssRef = html.match(/\/assets\/[A-Za-z0-9._-]+\.css/)?.[0] ?? '';
  const js = await browser.call(jsRef);
  const css = await browser.call(cssRef);
  check('the hashed JS bundle is served', js.status === 200 && /javascript/.test(js.headers.get('content-type') ?? ''));
  check('the hashed stylesheet is served', css.status === 200 && /text\/css/.test(css.headers.get('content-type') ?? ''));
  check('the served JS is the file on disk', js.text === fs.readFileSync(path.join(WEB_DIST, jsRef.replace(/^\//, '')), 'utf8'));

  // Static serving must not be able to answer for the API.
  const unknownApi = await browser.call('/api/does-not-exist');
  check('an unknown API path is refused by the gate, not answered with the app', unknownApi.status === 401);
  check('and the refusal is JSON, never index.html', unknownApi.json !== null && !unknownApi.text.includes('<div id="root">'));

  const protectedRoute = await browser.call('/api/emails');
  check('a protected API route is refused anonymously', protectedRoute.status === 401);

  // Hash routing: the server only ever sees `/`.
  const unknownPath = await browser.call('/deals');
  check('an unknown non-API path is NOT the app (no SPA fallback)', unknownPath.status !== 200, `status ${unknownPath.status}`);
}

// --- 5. authentication against the production build -------------------------

section('5. Authentication, CSRF and session lifecycle');
{
  const browser = new Browser(main.baseUrl);

  const anonymous = await browser.call('/api/emails');
  check('anonymous → protected API refused', anonymous.status === 401);

  const wrong = await browser.loginRaw('definitely-not-the-password');
  check('a wrong password is refused', wrong.status === 401);
  check('and issues no session cookie', !browser.hasSession);

  const signIn = await browser.loginRaw(OPERATOR_PASSWORD);
  check('the correct password signs in', signIn.status === 200);
  check('a session cookie is issued', browser.hasSession);

  const sessionCookie = signIn.setCookie.find((c) => c.startsWith('inbox_session=')) ?? '';
  const csrfCookie = signIn.setCookie.find((c) => c.startsWith('inbox_csrf=')) ?? '';
  check('the session cookie is HttpOnly', /HttpOnly/i.test(sessionCookie));
  check('the session cookie is Secure under production config', /Secure/i.test(sessionCookie));
  check('the session cookie is SameSite=Strict', /SameSite=Strict/i.test(sessionCookie));
  check('the CSRF cookie is readable by the client', !/HttpOnly/i.test(csrfCookie) && csrfCookie !== '');
  check('the CSRF cookie is Secure and SameSite=Strict', /Secure/i.test(csrfCookie) && /SameSite=Strict/i.test(csrfCookie));

  const authed = await browser.call('/api/emails');
  check('an authenticated read succeeds', authed.status === 200);
  // The inbox is legitimately empty here: `crm-seed.json` seeds companies,
  // contacts, deals, tasks, activities and notes — never emails, which exist
  // only once something is ingested. Asserting rows here would have been
  // asserting the wrong thing; the ingest below is where emails appear.
  check('the inbox is a well-formed list', Array.isArray((authed.json as { emails?: unknown[] }).emails));

  const crm = await browser.call('/api/deals');
  check('the CRM projection is reachable when signed in', crm.status === 200);
  check(
    'and returns real seeded rows',
    Array.isArray((crm.json as { deals?: unknown[] }).deals) && (crm.json as { deals: unknown[] }).deals.length > 0,
    `deals=${((crm.json as { deals?: unknown[] }).deals ?? []).length}`,
  );

  // CSRF: the same mutation, with and without the header.
  const noCsrf = await browser.call('/api/emails/ingest', { method: 'POST', body: {}, csrf: false });
  check('a mutation without the CSRF header is refused', noCsrf.status === 403, `status ${noCsrf.status}`);

  const withCsrf = await browser.call('/api/emails/ingest', { method: 'POST', body: {} });
  check('the same mutation with the CSRF header is accepted', withCsrf.status === 200, `status ${withCsrf.status}`);

  // PRECONDITION for the check above: a 200 that changed nothing would make
  // "accepted" meaningless, so confirm the mutation actually wrote.
  const afterIngest = await browser.call('/api/emails');
  check(
    'and the accepted mutation really ingested email',
    ((afterIngest.json as { emails?: unknown[] }).emails ?? []).length > 0,
    'the write was accepted but produced nothing',
  );

  const logout = await browser.call('/api/auth/logout', { method: 'POST', body: {} });
  check('logout succeeds', logout.status === 200);
  check('the session cookie is cleared', !browser.hasSession);

  const afterLogout = await browser.call('/api/emails');
  check('after logout the protected API is refused again', afterLogout.status === 401);
}

await main.stop();

// --- 6. rate limiting, on a fresh budget ------------------------------------

section('6. Rate limiting under the production configuration');
{
  // Its own server so the login budget is untouched by section 5.
  const server = await startServer(PROD_ENV);
  await assertThrowawayDatabase(server.baseUrl);
  const browser = new Browser(server.baseUrl);

  let limited = 0;
  let attempts = 0;
  for (let i = 0; i < 14; i++) {
    attempts++;
    const reply = await browser.call('/api/auth/login', { method: 'POST', body: { password: 'wrong' } });
    if (reply.status === 429) limited++;
  }
  check('repeated sign-in attempts are eventually rate limited', limited > 0, `${limited} of ${attempts} refused`);
  check('the limit did not fire immediately', limited < attempts, 'the first attempt should be allowed');

  // TRUST_PROXY=0 locally: a forwarding header must not buy a fresh budget.
  const spoofed = await browser.call('/api/auth/login', {
    method: 'POST',
    body: { password: 'wrong' },
    forwardedFor: '203.0.113.7',
  });
  check('a spoofed X-Forwarded-For does not reset the budget at TRUST_PROXY=0', spoofed.status === 429, `status ${spoofed.status}`);

  await server.stop();
}

// --- 7. TRUST_PROXY=1 resolves and does not weaken anything -----------------

section('7. TRUST_PROXY=1 resolves without loosening any boundary');
{
  const server = await startServer({ ...PROD_ENV, TRUST_PROXY: '1' });
  await assertThrowawayDatabase(server.baseUrl);
  const browser = new Browser(server.baseUrl);

  // Behind one proxy the real address is appended to the RIGHT of anything the
  // caller sent, so a spoofed prefix is read past rather than believed.
  const first = await browser.call('/api/auth/login', { method: 'POST', body: { password: 'wrong' }, forwardedFor: '9.9.9.9, 10.0.0.1' });
  check('the server starts and answers with TRUST_PROXY=1', first.status === 401 || first.status === 429);

  let sameClient = 0;
  for (let i = 0; i < 12; i++) {
    const reply = await browser.call('/api/auth/login', {
      method: 'POST',
      body: { password: 'wrong' },
      // A different lie each time, the same real client appended by the "proxy".
      forwardedFor: `${i}.${i}.${i}.${i}, 10.0.0.1`,
    });
    if (reply.status === 429) sameClient++;
  }
  check('a rotating spoofed prefix cannot escape one client bucket', sameClient > 0, 'the spoofed prefix was believed');

  const health = await browser.call('/api/health');
  const adapters = (health.json as { adapters: Record<string, unknown> }).adapters;
  check('outbound sending is still off with a proxy configured', adapters.outboundSendEnabled === false);
  check('sign-in is still required', adapters.authConfigured === true);
  check('secure cookies are still on', adapters.cookieSecure === true);
  check('the CORS allow-list is still empty', adapters.corsAllowedOrigins === 0);

  await server.stop();
}

// --- 8. NEGATIVE CONTROL -----------------------------------------------------

section('8. NEGATIVE CONTROL — the same server with no build to serve');
{
  // Everything in section 4 would also pass if `/` were being answered by
  // something other than static serving of the real build — a fallback, a
  // cached response, a stray route. Point the server at an empty directory and
  // the front-end checks MUST fail while the API keeps working. If `/` still
  // returns the app here, section 4 proved nothing.
  const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'm7b-empty-'));
  const server = await startServer({ ...PROD_ENV, WEB_DIST_DIR: emptyDist });
  await assertThrowawayDatabase(server.baseUrl);
  const browser = new Browser(server.baseUrl);

  const root = await browser.call('/');
  check('GET / does NOT return the app when there is no build', root.status !== 200, `status ${root.status}`);
  check('and specifically does not return the mounted app markup', !root.text.includes('<div id="root">'));

  const asset = await browser.call('/assets/index-DzjzL5ie.js');
  check('a hashed asset is not served from an empty build', asset.status !== 200);

  // The M7-A contract: a missing build degrades the dashboard, never the API.
  const health = await browser.call('/api/health');
  check('the API still answers with no build present', health.status === 200);
  const protectedRoute = await browser.call('/api/emails');
  check('and the gate is still closed', protectedRoute.status === 401);

  await server.stop();
  fs.rmSync(emptyDist, { recursive: true, force: true });
}

// --- done --------------------------------------------------------------------

fs.rmSync(workDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(` RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n Failures:');
  for (const failure of failures) console.log(`   - ${failure}`);
  process.exitCode = 1;
}
console.log('='.repeat(60));
