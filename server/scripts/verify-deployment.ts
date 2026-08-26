import { createInterface } from 'node:readline/promises';

// M7-E — verification of a LIVE deployment.
//
//   npm run verify:deployment -- https://inbox-crm-agent.onrender.com
//   npm run verify:deployment -- https://... --auth      (adds the signed-in checks)
//
// WHY THIS EXISTS SEPARATELY FROM verify-production.ts
//
// M7-B's harness spawns the server locally and proves the code is right. It
// cannot say anything about the deployment: whether the built assets actually
// shipped, whether the platform terminates TLS, whether the environment the
// process booted with is the one intended, or whether the database it reached
// is the production one. Those are properties of a running deployment and can
// only be checked against a URL.
//
// THE SPLIT, AND WHY IT IS NOT NEGOTIABLE
//
// Everything that can be checked without a credential runs by default. The
// signed-in checks require the operator password, which is read from an
// interactive prompt and held only in memory — never an argument (arguments
// land in shell history and the process list), never a file, never a log line,
// and never printed. Nothing derived from it is printed either: the cookie
// checks report attribute presence, not values.
//
// WHAT IT MAY DO TO THE TARGET
//
// One deliberate write: `POST /api/emails/ingest`, which is how the CSRF
// success path is proven. It is idempotent — ingestion inserts only messages it
// has not seen — and it pulls in the demo inbox the deployment needs anyway.
// Nothing else mutates. No approval is granted, no plan is executed, no reply
// is ever delivered.

const DEFAULT_URL = 'https://inbox-crm-agent.onrender.com';

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => !a.startsWith('--')) ?? DEFAULT_URL).replace(/\/$/, '');
const wantAuth = args.includes('--auth');

let passed = 0;
let failed = 0;
let warned = 0;
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

function warn(label: string, detail = ''): void {
  warned++;
  console.log(`    WARN  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Long timeout throughout: a free-tier instance can take ~50s to wake. */
const TIMEOUT_MS = 120_000;

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// ============================================================== warm-up

console.log('M7-E — live deployment verification');
console.log('='.repeat(60));
console.log(`  target: ${baseUrl}`);

section('0. Waking the instance');
{
  const started = Date.now();
  let awake = false;
  for (let attempt = 1; attempt <= 3 && !awake; attempt++) {
    try {
      const response = await get('/api/health');
      awake = response.ok;
    } catch {
      /* still cold */
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  check('the service answers', awake, 'no response after 3 attempts');
  console.log(`          (cold start took ${seconds}s — free tier sleeps after ~15 min idle)`);
  if (!awake) {
    console.log('\n  Cannot continue against an unreachable deployment.');
    process.exit(1);
  }
}

// ================================================== 1. transport and health

section('1. Transport and health');
let health: {
  status: string;
  version: string;
  database: { driver: string; reachable: boolean; migrationsApplied: number };
  adapters: Record<string, string | boolean | number>;
};
{
  check('served over HTTPS', baseUrl.startsWith('https://'), baseUrl);

  const response = await get('/api/health');
  check('GET /api/health returns 200', response.status === 200, `got ${response.status}`);
  check('and answers JSON', /application\/json/.test(response.headers.get('content-type') ?? ''));

  health = (await response.json()) as typeof health;
  check('status is ok', health.status === 'ok', health.status);
  check('running the production database', health.database.driver === 'postgres', health.database.driver);
  check('the database is reachable', health.database.reachable === true);
  check('all ten migrations are applied', health.database.migrationsApplied === 10, `${health.database.migrationsApplied}`);
  check('the version is not a milestone label', !/^M\d/.test(health.version), health.version);
}

// ============================================== 2. security configuration

section('2. Security configuration as deployed');
{
  const a = health.adapters;
  check('sign-in is configured', a.authConfigured === true);
  check('secure cookies are on', a.cookieSecure === true);
  check('outbound sending is OFF', a.outboundSendEnabled === false);
  check('the model provider is the deterministic mock', a.llmProvider === 'mock', String(a.llmProvider));

  // Reported, not enforced: the single-origin design wants an empty allow-list,
  // but the deployed value is an operator decision and M7-E does not change it.
  const origins = Number(a.corsAllowedOrigins ?? 0);
  if (origins === 0) {
    check('the CORS allow-list is empty (single-origin)', true);
  } else {
    warn(
      `the CORS allow-list has ${origins} entr${origins === 1 ? 'y' : 'ies'}`,
      'single-origin serving needs none; kept by operator decision',
    );
  }
}

// ================================================ 3. the front end shipped

section('3. The front end actually shipped');
let indexHtml = '';
{
  const response = await get('/');
  indexHtml = await response.text();

  check('GET / returns 200', response.status === 200, `got ${response.status}`);
  check('and returns HTML', /text\/html/.test(response.headers.get('content-type') ?? ''));
  check('the app mount point is present', indexHtml.includes('<div id="root">'));

  const js = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(indexHtml)?.[0] ?? '';
  const css = /\/assets\/[A-Za-z0-9._-]+\.css/.exec(indexHtml)?.[0] ?? '';
  check('it references a hashed JS bundle', js.length > 0, 'none referenced');
  check('it references a hashed stylesheet', css.length > 0, 'none referenced');

  let bundle = indexHtml;
  if (js) {
    const asset = await get(js);
    const body = await asset.text();
    bundle += body;
    check('the hashed JS bundle loads', asset.status === 200, `got ${asset.status}`);
    check('with a JavaScript content type', /javascript/.test(asset.headers.get('content-type') ?? ''));
    check('and is a real application, not a stub', body.length > 100_000, `${body.length} bytes`);
  }
  if (css) {
    const asset = await get(css);
    bundle += await asset.text();
    check('the hashed stylesheet loads', asset.status === 200, `got ${asset.status}`);
    check('with a CSS content type', /text\/css/.test(asset.headers.get('content-type') ?? ''));
  }

  // The checks that matter most about what reaches a browser.
  const secretShaped =
    /sk-ant-[A-Za-z0-9]{6,}|postgres(?:ql)?:\/\/[^\s"']*:[^\s"']*@|scrypt\$\d+\$|OPERATOR_PASSWORD_HASH|ANTHROPIC_API_KEY/;
  check('no secret-shaped string is shipped to the browser', !secretShaped.test(bundle));

  const absoluteApi = /https?:\/\/[a-zA-Z0-9.:-]+\/api/.exec(bundle);
  check('no absolute API host is baked into the bundle', absoluteApi === null, absoluteApi?.[0] ?? '');
  const localhost = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.exec(bundle);
  check('no localhost URL survives into the build', localhost === null, localhost?.[0] ?? '');
  check('the client addresses the API relatively', /['"`]\/api['"`]/.test(bundle));
}

// ================================================= 4. the gate, anonymously

section('4. The gate, without a session');
{
  const protectedRoute = await get('/api/emails');
  check('a protected API route returns 401', protectedRoute.status === 401, `got ${protectedRoute.status}`);
  const body = await protectedRoute.text();
  check('and answers JSON, never the app', !body.includes('<div id="root">') && body.trim().startsWith('{'));

  const unknownApi = await get('/api/does-not-exist');
  check('an unknown API path is refused, not answered with the app', unknownApi.status === 401, `got ${unknownApi.status}`);

  // Hash routing: the server only ever sees `/` and the assets beside it, so a
  // history-API fallback would turn every genuine 404 into a 200.
  const unknownPath = await get('/deals');
  check('an unknown non-API path is NOT the app (no SPA fallback)', unknownPath.status !== 200, `got ${unknownPath.status}`);

  const login = await get('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'deployment-probe-not-a-real-password' }),
  });
  check('a wrong password is refused with 401', login.status === 401, `got ${login.status}`);
  check('and sets no cookie', login.headers.getSetCookie().length === 0);
  check('rate limiting is active on sign-in', login.headers.get('x-ratelimit-limit') !== null,
    'no x-ratelimit-limit header');
}

// =============================================== 5. signed in (optional)

if (!wantAuth) {
  section('5. Signed-in checks');
  console.log('    SKIPPED — re-run with --auth to include them.');
  console.log('    They need the operator password, which is prompted for and never stored.');
} else {
  section('5. Signed in');

  if (!process.stdin.isTTY) {
    console.log('    FAIL  --auth needs an interactive terminal for the password prompt.');
    failed++;
    failures.push('interactive terminal for --auth');
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('    The password is held in memory only. It is never printed, stored or sent anywhere');
    console.log('    but this deployment, and nothing derived from it is displayed.\n');
    const password = await rl.question('    Operator password: ');
    rl.close();
    console.log();

    const jar = new Map<string, string>();
    const absorb = (response: Response): void => {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';')[0] as string;
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = (): string => decodeURIComponent(jar.get('inbox_csrf') ?? '');

    const call = async (
      path: string,
      init: { method?: string; body?: unknown; csrf?: boolean } = {},
    ): Promise<{ status: number; json: unknown; setCookie: string[] }> => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const cookies = cookieHeader();
      if (cookies) headers.cookie = cookies;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrf() && init.csrf !== false) {
        headers['x-csrf-token'] = csrf();
      }
      const response = await get(path, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const setCookie = response.headers.getSetCookie();
      absorb(response);
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: response.status, json, setCookie };
    };

    // --- sign in ------------------------------------------------------------
    const signIn = await call('/api/auth/login', { method: 'POST', body: { password } });
    check('the operator password is accepted', signIn.status === 200, `got ${signIn.status}`);

    if (signIn.status !== 200) {
      console.log('    Remaining signed-in checks skipped: sign-in did not succeed.');
    } else {
      // Attribute presence only — no cookie value is read or printed.
      const session = signIn.setCookie.find((c) => c.startsWith('inbox_session=')) ?? '';
      const csrfCookie = signIn.setCookie.find((c) => c.startsWith('inbox_csrf=')) ?? '';
      check('the session cookie is HttpOnly', /HttpOnly/i.test(session));
      check('the session cookie is Secure', /Secure/i.test(session));
      check('the session cookie is SameSite=Strict', /SameSite=Strict/i.test(session));
      check('the CSRF cookie is readable by the client', csrfCookie !== '' && !/HttpOnly/i.test(csrfCookie));
      check('the CSRF cookie is Secure', /Secure/i.test(csrfCookie));
      check('the CSRF cookie is SameSite=Strict', /SameSite=Strict/i.test(csrfCookie));

      // --- authenticated reads ---------------------------------------------
      const emails = await call('/api/emails');
      check('an authenticated read succeeds', emails.status === 200, `got ${emails.status}`);

      const deals = await call('/api/deals');
      const contacts = await call('/api/contacts');
      const companies = await call('/api/companies');
      const dealCount = ((deals.json as { deals?: unknown[] })?.deals ?? []).length;
      const contactCount = ((contacts.json as { contacts?: unknown[] })?.contacts ?? []).length;
      const companyCount = ((companies.json as { companies?: unknown[] })?.companies ?? []).length;
      check('the seeded CRM is visible', dealCount >= 4 && contactCount >= 9 && companyCount >= 6,
        `deals=${dealCount} contacts=${contactCount} companies=${companyCount}`);

      // --- CSRF -------------------------------------------------------------
      const noCsrf = await call('/api/emails/ingest', { method: 'POST', body: {}, csrf: false });
      check('a mutation WITHOUT the CSRF header is refused with 403', noCsrf.status === 403, `got ${noCsrf.status}`);

      const withCsrf = await call('/api/emails/ingest', { method: 'POST', body: {} });
      check('the same mutation WITH the CSRF header succeeds', withCsrf.status === 200, `got ${withCsrf.status}`);

      const afterIngest = await call('/api/emails');
      const inboxCount = ((afterIngest.json as { emails?: unknown[] })?.emails ?? []).length;
      check('and the accepted mutation really ingested email', inboxCount > 0, `${inboxCount} emails`);

      // --- outbound stays shut ---------------------------------------------
      const audit = await call('/api/audit');
      const events = ((audit.json as { events?: Array<{ eventType: string }> })?.events ?? []);
      const delivered = events.filter((e) => e.eventType === 'outbound_send_succeeded');
      check('no reply has ever been delivered from this deployment', delivered.length === 0,
        `${delivered.length} delivery event(s)`);
      check('health still reports outbound sending off', health.adapters.outboundSendEnabled === false);

      // --- sign out ---------------------------------------------------------
      const logout = await call('/api/auth/logout', { method: 'POST', body: {} });
      check('logout succeeds', logout.status === 200, `got ${logout.status}`);
      check('the session cookie is cleared', !jar.has('inbox_session'));

      const afterLogout = await call('/api/emails');
      check('the protected API is refused again after logout', afterLogout.status === 401, `got ${afterLogout.status}`);
    }
  }
}

// ================================================================== result

console.log(`\n${'='.repeat(60)}`);
console.log(` RESULT: ${passed} passed, ${failed} failed${warned ? `, ${warned} warning(s)` : ''}`);
if (failed > 0) {
  console.log('\n Failures:');
  for (const failure of failures) console.log(`   - ${failure}`);
  process.exitCode = 1;
}
console.log('='.repeat(60));
