import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTestContext } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { isCsrfExempt, isSafeMethod, CSRF_HEADER } from '../src/auth/csrf.ts';
import type { AppConfig } from '../src/config/env.ts';

// M5-B — CSRF and CORS.
//
// The session cookie is `SameSite=Strict`, so a browser already refuses to
// attach it cross-site. These tests are about what happens when that promise is
// not available — an older browser, a hostile same-site subdomain, or a future
// `SameSite` relaxation for an OAuth redirect (which Gmail will bring).
//
// The attacks are performed against the server directly, not through the UI,
// because that is the only way to find out whether the server actually refuses
// or merely whether the front end declines to ask.

const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;
const ORIGIN = 'https://app.example.com';

type Server = {
  url: string;
  cookie: string;
  csrf: string;
  stop(): Promise<void>;
};

async function serve(over: Partial<AppConfig> = {}): Promise<Server> {
  const ctx = await createTestContext({ idPrefix: 'm5b' });
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    ...over,
  };

  const app = createApp({ db: ctx.db, config, logger: quiet });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const setCookie = login.headers.getSetCookie();
  const token = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
  const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';

  return {
    url,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    csrf: csrf ?? '',
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

// --- the exemption rule ------------------------------------------------------

test('only safe methods and login are exempt from CSRF', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
    assert.equal(isSafeMethod(method), true, `${method} should be safe`);
    assert.equal(isCsrfExempt(method, '/emails'), true);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isSafeMethod(method), false, `${method} should not be safe`);
    assert.equal(isCsrfExempt(method, '/emails'), false);
  }

  // Login precedes the session, so it has no token to echo.
  assert.equal(isCsrfExempt('POST', '/auth/login'), true);
  // Logout does not — being signed out by a cross-site page is worth preventing.
  assert.equal(isCsrfExempt('POST', '/auth/logout'), false);
});

// --- CSRF on real requests ---------------------------------------------------

test('an authenticated mutation succeeds with a valid CSRF token', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
      body: '{}',
    });
    assert.equal(response.status, 200);
  } finally {
    await s.stop();
  }
});

test('an authenticated mutation without a CSRF token is refused', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie },
      body: '{}',
    });

    assert.equal(response.status, 403, 'a mutation ran without CSRF protection');
    const body = (await response.json()) as { error: { code: string; message: string; details?: unknown } };
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.deepEqual(body.error.details, { reason: 'csrf_token_invalid' });
    // 403 not 401: the caller is signed in, so "sign in again" would be a loop
    // that cannot fix the problem.
    assert.ok(!/sign in/i.test(body.error.message));
  } finally {
    await s.stop();
  }
});

test('an incorrect CSRF token is refused, including another session\'s', async () => {
  const s = await serve();
  const other = await serve();
  try {
    for (const token of ['', 'not-the-token', s.csrf.slice(0, -1), `${s.csrf}x`, other.csrf]) {
      const response = await fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: token },
        body: '{}',
      });
      assert.equal(response.status, 403, `CSRF token "${token.slice(0, 12)}" was accepted`);
    }
  } finally {
    await s.stop();
    await other.stop();
  }
});

test('a CSRF token stops working when its session ends', async () => {
  // The token is bound to the session, not global. It must die with it.
  const s = await serve();
  try {
    await fetch(`${s.url}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf },
    });

    const response = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
      body: '{}',
    });
    assert.equal(response.status, 401, 'a revoked session still accepted its old CSRF token');
  } finally {
    await s.stop();
  }
});

test('logout is CSRF-protected but login is not', async () => {
  const s = await serve();
  try {
    // Logout without a token: refused, and the session survives.
    const refused = await fetch(`${s.url}/api/auth/logout`, { method: 'POST', headers: { cookie: s.cookie } });
    assert.equal(refused.status, 403);
    assert.equal((await fetch(`${s.url}/api/emails`, { headers: { cookie: s.cookie } })).status, 200);

    // Login needs none, because there is no session yet to carry one.
    const login = await fetch(`${s.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
  } finally {
    await s.stop();
  }
});

test('a safe GET needs no CSRF token', async () => {
  const s = await serve();
  try {
    for (const path of ['/api/emails', '/api/approvals', '/api/auth/session', '/api/health']) {
      const response = await fetch(`${s.url}${path}`, { headers: { cookie: s.cookie } });
      assert.ok(response.status < 400, `${path} required CSRF for a read`);
    }
  } finally {
    await s.stop();
  }
});

test('CSRF is checked before the route, so a bad token cannot reach a handler', async () => {
  // A 403 on a decision id that does not exist proves the check ran first — a
  // handler would have answered 404.
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/decisions/no-such-decision/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie },
      body: '{}',
    });
    assert.equal(response.status, 403);
  } finally {
    await s.stop();
  }
});

// --- CORS --------------------------------------------------------------------

test('with no configured origins, no CORS headers are emitted', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/health`, { headers: { origin: ORIGIN } });
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'an unapproved origin was echoed');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  } finally {
    await s.stop();
  }
});

test('a configured origin is echoed exactly, with credentials and Vary', async () => {
  const s = await serve({ corsAllowedOrigins: [ORIGIN] });
  try {
    const response = await fetch(`${s.url}/api/health`, { headers: { origin: ORIGIN } });

    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('vary') ?? '', /Origin/, 'a shared cache could cross origins');
  } finally {
    await s.stop();
  }
});

test('an unlisted origin is never reflected, and its writes are refused server-side', async () => {
  const s = await serve({ corsAllowedOrigins: [ORIGIN] });
  try {
    const hostile = 'https://evil.example.com';

    const read = await fetch(`${s.url}/api/health`, { headers: { origin: hostile } });
    assert.notEqual(read.headers.get('access-control-allow-origin'), hostile, 'Origin was reflected');
    assert.equal(read.headers.get('access-control-allow-origin'), null);

    // A write is refused by the server, not merely hidden from the browser —
    // withholding headers would let the write happen and only stop the attacker
    // reading the answer.
    const write = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: hostile,
        cookie: s.cookie,
        [CSRF_HEADER]: s.csrf,
      },
      body: '{}',
    });
    assert.equal(write.status, 403, 'a cross-origin write executed');
    const body = (await write.json()) as { error: { details?: unknown } };
    assert.deepEqual(body.error.details, { reason: 'origin_not_allowed' });
  } finally {
    await s.stop();
  }
});

test('a preflight from an unlisted origin is refused and from a listed one is answered', async () => {
  const s = await serve({ corsAllowedOrigins: [ORIGIN] });
  try {
    const refused = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);

    const allowed = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(allowed.headers.get('access-control-allow-headers') ?? '', /x-csrf-token/);
    assert.match(allowed.headers.get('access-control-allow-methods') ?? '', /POST/);
  } finally {
    await s.stop();
  }
});

test('a wildcard origin is rejected at configuration time, never combined with credentials', () => {
  const { config, problems } = loadConfig({ CORS_ALLOWED_ORIGINS: '*' });

  assert.deepEqual(config.corsAllowedOrigins, [], 'the wildcard survived into the allow-list');
  assert.ok(problems.some((problem) => /cannot be combined with credentialed/.test(problem)));

  // A wildcard mixed with real origins drops only the wildcard.
  const mixed = loadConfig({ CORS_ALLOWED_ORIGINS: `*, ${ORIGIN}` });
  assert.deepEqual(mixed.config.corsAllowedOrigins, [ORIGIN]);
});

test('malformed origin entries are dropped and reported', () => {
  const { config, problems } = loadConfig({
    CORS_ALLOWED_ORIGINS: `${ORIGIN}, app.example.com, https://x.example.com/path, ftp://nope.example.com`,
  });

  assert.deepEqual(config.corsAllowedOrigins, [ORIGIN], 'a malformed origin was allowed');
  assert.equal(problems.filter((problem) => /is not a scheme:\/\/host origin/.test(problem)).length, 3);
});

test('same-origin requests carry no Origin header and are unaffected', async () => {
  const s = await serve({ corsAllowedOrigins: [ORIGIN] });
  try {
    // No Origin at all — a same-origin GET, or a non-browser client.
    const response = await fetch(`${s.url}/api/emails`, { headers: { cookie: s.cookie } });
    assert.equal(response.status, 200);

    const write = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
      body: '{}',
    });
    assert.equal(write.status, 200, 'a same-origin write was refused');
  } finally {
    await s.stop();
  }
});

// --- cookie attributes -------------------------------------------------------

test('cookie attributes are correct for both cookies', async () => {
  const ctx = await createTestContext({ idPrefix: 'm5b-cookie' });
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: true,
  };
  const app = createApp({ db: ctx.db, config, logger: quiet });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(SESSION_COOKIE)) as string;
    const csrf = cookies.find((c) => c.startsWith(CSRF_COOKIE)) as string;

    for (const [name, cookie] of [['session', session], ['csrf', csrf]] as const) {
      assert.match(cookie, /SameSite=Strict/, `${name} is not SameSite=Strict`);
      assert.match(cookie, /Secure/, `${name} is not Secure when configured to be`);
      assert.match(cookie, /Path=\//, `${name} has no Path`);
    }

    assert.match(session, /HttpOnly/, 'the session cookie is readable from JavaScript');
    assert.ok(!/HttpOnly/.test(csrf), 'the CSRF cookie must be readable to be echoed back');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
});

test('no CSRF or CORS refusal leaks a secret', async () => {
  const s = await serve({ corsAllowedOrigins: [ORIGIN] });
  try {
    const csrfFailure = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie },
      body: '{}',
    });
    const originFailure = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com',
        cookie: s.cookie,
        [CSRF_HEADER]: s.csrf,
      },
      body: '{}',
    });

    for (const response of [csrfFailure, originFailure]) {
      const text = await response.text();
      assert.ok(!text.includes(s.csrf), 'a refusal echoed the expected CSRF token');
      assert.ok(!text.includes(PASSWORD));
      assert.ok(!/scrypt\$|sk-|inbox_session/.test(text), 'a refusal leaked a credential');
    }
  } finally {
    await s.stop();
  }
});
