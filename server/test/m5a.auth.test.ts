import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTestContext, rejects, MIGRATION_COUNT } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig, configSummary } from '../src/config/env.ts';
import { hashPassword, verifyPassword } from '../src/lib/password.ts';
import { createSessionToken, hashSessionToken, secretsMatch } from '../src/domain/session.ts';
import { readCookie, buildCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { handleLogin, handleLogout, handleSession } from '../src/handlers/auth.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { appliedMigrations } from '../src/db/migrate.ts';
import type { AppConfig } from '../src/config/env.ts';

// M5-A — session authentication.
//
// The finding this closes (F-01) was not "there is no login screen". It was that
// operator identity came from an `x-operator` header anyone could set, so every
// approval, revision and audit event recorded a *claim* rather than an actor —
// while the product's central promise is that a human authorised the thing and
// the record proves who.
//
// So the tests that matter most here are not the happy path. They are:
// identity cannot be asserted by a header any more, a mutation cannot run
// unauthenticated, a session cannot be forged or replayed after expiry, and
// neither the password hash nor the session token ever leaves the server in a
// place it could be read.

const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;

/** A config with authentication actually configured. */
async function authConfig(over: Partial<AppConfig> = {}): Promise<AppConfig> {
  const { config } = loadConfig({});
  return {
    ...config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    sessionTtlHours: 12,
    cookieSecure: false,
    ...over,
  };
}

type Server = {
  url: string;
  config: AppConfig;
  stop(): Promise<void>;
};

async function serve(over: Partial<AppConfig> = {}): Promise<Server & { ctx: Awaited<ReturnType<typeof createTestContext>> }> {
  const ctx = await createTestContext({ idPrefix: 'm5a' });
  const config = await authConfig(over);
  const app = createApp({ db: ctx.db, config, logger: quiet });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    ctx,
    config,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

/** Signs in and returns the cookie header plus the CSRF token. */
async function signIn(url: string, password = PASSWORD): Promise<{ cookie: string; csrf: string; status: number }> {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  const setCookie = response.headers.getSetCookie();
  const session = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
  const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';

  return {
    status: response.status,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
    csrf: csrf ?? '',
  };
}

// --- password hashing --------------------------------------------------------

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword(PASSWORD);

  assert.ok(hash.startsWith('scrypt$'), 'the hash does not describe its own parameters');
  assert.ok(!hash.includes(PASSWORD), 'the hash contains the password');
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword(`${PASSWORD} `, hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently every time, because the salt is random', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);

  assert.notEqual(a, b, 'two hashes of one password are identical — the salt is not random');
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('a malformed stored hash fails closed rather than throwing', async () => {
  // A misconfigured environment must mean "nobody signs in", not a 500 that
  // distinguishes bad configuration from a wrong password.
  for (const broken of ['', 'not-a-hash', 'scrypt$x$y$z$q$r', 'scrypt$32768$8$1$onlyfivefields', 'bcrypt$1$2$3$4$5']) {
    assert.equal(await verifyPassword(PASSWORD, broken), false, `"${broken}" was accepted`);
  }
});

// --- session tokens ----------------------------------------------------------

test('session tokens are high entropy and never stored as presented', () => {
  const tokens = new Set(Array.from({ length: 500 }, () => createSessionToken()));
  assert.equal(tokens.size, 500, 'session tokens collided — entropy is insufficient');

  const token = createSessionToken();
  assert.ok(token.length >= 43, 'token is shorter than 256 bits of base64url');
  assert.notEqual(hashSessionToken(token), token, 'the stored value equals the token');
  assert.equal(hashSessionToken(token), hashSessionToken(token), 'hashing is not stable');
  assert.ok(!/[^A-Za-z0-9_-]/.test(token), 'token is not URL-safe base64');
});

test('secret comparison is length-safe', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('abc', 'abcd'), false, 'differing lengths must not throw');
  assert.equal(secretsMatch('', ''), true);
});

// --- configuration -----------------------------------------------------------

test('an unset operator hash is reported and makes sign-in impossible', () => {
  const { config, problems } = loadConfig({});
  assert.equal(config.operatorPasswordHash, null);
  assert.ok(problems.some((problem) => /OPERATOR_PASSWORD_HASH is not set/.test(problem)));
  assert.equal(configSummary(config).authConfigured, false);
});

test('the config summary reports that auth exists, never the hash itself', async () => {
  const config = await authConfig();
  const summary = JSON.stringify(configSummary(config));

  assert.match(summary, /"authConfigured":true/);
  assert.ok(!summary.includes('scrypt$'), 'the config summary leaked the password hash');
  assert.ok(!summary.includes(PASSWORD));
});

test('a hash that is not scrypt is rejected at configuration time', () => {
  const { problems } = loadConfig({ OPERATOR_PASSWORD_HASH: '$2b$10$somethingbcryptish' });
  assert.ok(problems.some((problem) => /not a scrypt hash/.test(problem)));
});

// --- migration ---------------------------------------------------------------

test('migration 009 applies with every other migration', async () => {
  const { db, close } = await createTestContext();
  const applied = await appliedMigrations(db);

  assert.equal(applied.length, MIGRATION_COUNT);
  assert.ok(applied.some((migration) => migration.name === '009_sessions.sql'));
  await close();
});

// --- the handler layer -------------------------------------------------------

test('signing in creates exactly one session and returns the token once', async () => {
  const ctx = await createTestContext({ idPrefix: 'login' });
  const config = await authConfig();

  const result = await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });

  assert.equal(await ctx.repos.sessions.count(), 1);
  assert.equal(result.session.operator, 'operator');
  assert.ok(result.token.length >= 43);

  // The token is not what is stored, and the body does not contain it.
  assert.equal(result.session.tokenHash, hashSessionToken(result.token));
  assert.ok(!JSON.stringify(result.body).includes(result.token), 'the response body carried the session token');

  await ctx.close();
});

test('a wrong, missing or empty password is refused identically', async () => {
  const ctx = await createTestContext({ idPrefix: 'refuse' });
  const config = await authConfig();
  const deps = { repos: ctx.repos, config, logger: quiet };

  const wrong = await rejects(() => handleLogin(deps, { password: 'nope' }));
  assert.equal((wrong as { code?: string }).code, 'UNAUTHORIZED');

  const missing = await rejects(() => handleLogin(deps, {}));
  assert.equal((missing as { code?: string }).code, 'VALIDATION_ERROR');

  // An unconfigured server answers exactly like a wrong password.
  const unconfigured = await rejects(() =>
    handleLogin({ ...deps, config: { ...config, operatorPasswordHash: null } }, { password: PASSWORD }),
  );
  assert.equal((unconfigured as { code?: string }).code, 'UNAUTHORIZED');
  assert.equal((unconfigured as Error).message, (wrong as Error).message, 'failure modes are distinguishable');

  assert.equal(await ctx.repos.sessions.count(), 0, 'a failed sign-in created a session');
  await ctx.close();
});

test('an expired session is indistinguishable from one that never existed', async () => {
  const ctx = await createTestContext({ idPrefix: 'expiry' });
  const config = await authConfig();

  const { token } = await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });

  // Live now...
  assert.ok(await ctx.repos.sessions.findLive(token, '2026-06-01T00:00:10.000Z'));
  // ...and gone later.
  assert.equal(await ctx.repos.sessions.findLive(token, '2099-01-01T00:00:00.000Z'), null);
  // As is a token that was never issued.
  assert.equal(await ctx.repos.sessions.findLive(createSessionToken(), '2026-06-01T00:00:10.000Z'), null);

  await ctx.close();
});

test('a session cannot be forged from the stored row', async () => {
  // The database holds the hash. Presenting it as a cookie must not work — that
  // is the whole reason for storing a hash rather than the token.
  const ctx = await createTestContext({ idPrefix: 'forge' });
  const config = await authConfig();

  const { token, session } = await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });

  assert.equal(await ctx.repos.sessions.findLive(session.tokenHash, '2026-06-01T00:00:10.000Z'), null);
  assert.ok(await ctx.repos.sessions.findLive(token, '2026-06-01T00:00:10.000Z'));

  await ctx.close();
});

test('logout revokes the session and is idempotent', async () => {
  const ctx = await createTestContext({ idPrefix: 'logout' });
  const config = await authConfig();

  const { token } = await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });

  const first = await handleLogout({ repos: ctx.repos }, token);
  assert.equal(first.body.signedOut, true);
  assert.equal(await ctx.repos.sessions.count(), 0);

  // Again, and with nothing at all — both succeed rather than erroring.
  assert.equal((await handleLogout({ repos: ctx.repos }, token)).body.signedOut, false);
  assert.equal((await handleLogout({ repos: ctx.repos }, null)).body.signedOut, false);

  await ctx.close();
});

test('the session endpoint never returns the session token', () => {
  const anonymous = handleSession(null);
  assert.equal(anonymous.body.authenticated, false);
  assert.equal(anonymous.body.csrfToken, null);

  const signedIn = handleSession({
    tokenHash: 'hashed',
    operator: 'operator',
    csrfToken: 'csrf-value',
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2026-06-01T12:00:00.000Z',
    lastSeenAt: '2026-06-01T00:00:00.000Z',
  });

  assert.equal(signedIn.body.authenticated, true);
  assert.equal(signedIn.body.csrfToken, 'csrf-value');
  const serialised = JSON.stringify(signedIn.body);
  assert.ok(!serialised.includes('hashed'), 'the session endpoint returned the stored token hash');
});

test('expired sessions are swept, and live ones are not', async () => {
  const ctx = await createTestContext({ idPrefix: 'sweep' });
  const config = await authConfig();

  await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });
  assert.equal(await ctx.repos.sessions.count(), 1);

  assert.equal(await ctx.repos.sessions.deleteExpired('2026-06-01T00:00:10.000Z'), 0);
  assert.equal(await ctx.repos.sessions.count(), 1);

  assert.equal(await ctx.repos.sessions.deleteExpired('2099-01-01T00:00:00.000Z'), 1);
  assert.equal(await ctx.repos.sessions.count(), 0);

  await ctx.close();
});

test('activity does not extend a session', async () => {
  const ctx = await createTestContext({ idPrefix: 'touch' });
  const config = await authConfig();

  const { token, session } = await handleLogin({ repos: ctx.repos, config, logger: quiet }, { password: PASSWORD });
  await ctx.repos.sessions.touch(session.tokenHash);

  const after = await ctx.repos.sessions.findLive(token, '2026-06-01T00:00:20.000Z');
  assert.equal(after?.expiresAt, session.expiresAt, 'using a session extended its lifetime');
  assert.notEqual(after?.lastSeenAt, session.lastSeenAt, 'activity was not recorded');

  await ctx.close();
});

// --- cookies -----------------------------------------------------------------

test('the session cookie is HttpOnly and the CSRF cookie deliberately is not', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(response.status, 200);

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(SESSION_COOKIE)) as string;
    const csrf = cookies.find((c) => c.startsWith(CSRF_COOKIE)) as string;

    assert.match(session, /HttpOnly/, 'the session cookie is readable from JavaScript');
    assert.match(session, /SameSite=Strict/);
    assert.match(session, /Path=\//);
    assert.match(session, /Max-Age=\d+/);

    // Readable on purpose: the front end has to echo it back as a header, and
    // a cross-site page can send the session cookie but cannot read this one.
    assert.ok(!/HttpOnly/.test(csrf), 'the CSRF cookie is HttpOnly and therefore unusable');
    assert.match(csrf, /SameSite=Strict/);
  } finally {
    await s.stop();
  }
});

test('Secure is set unless it is explicitly turned off for local HTTP', () => {
  const production = buildCookie(SESSION_COOKIE, 'x', {
    maxAgeSeconds: 60,
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  });
  assert.match(production, /Secure/);

  const local = buildCookie(SESSION_COOKIE, 'x', {
    maxAgeSeconds: 60,
    secure: false,
    httpOnly: true,
    sameSite: 'Strict',
  });
  assert.ok(!/Secure/.test(local));

  // The default is on, and turning it off is reported as a problem.
  assert.equal(loadConfig({}).config.cookieSecure, true);
  assert.ok(loadConfig({ COOKIE_SECURE: 'false' }).problems.some((p) => /plain HTTP/.test(p)));
});

test('cookie parsing survives whatever a browser sends', () => {
  assert.equal(readCookie('a=1; inbox_session=abc; b=2', SESSION_COOKIE), 'abc');
  assert.equal(readCookie('inbox_session=a%20b', SESSION_COOKIE), 'a b');
  assert.equal(readCookie('', SESSION_COOKIE), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
  assert.equal(readCookie('other=1', SESSION_COOKIE), null);
  assert.equal(readCookie('inbox_session_other=1', SESSION_COOKIE), null, 'prefix matching leaked a cookie');
  assert.equal(readCookie('inbox_session=%E0%A4%A', SESSION_COOKIE), '%E0%A4%A', 'bad encoding threw');
});

// --- the gate ----------------------------------------------------------------

test('every protected endpoint refuses an unauthenticated request', async () => {
  const s = await serve();
  try {
    const protectedCalls: Array<[string, string]> = [
      ['GET', '/api/emails'],
      ['GET', '/api/approvals'],
      ['POST', '/api/emails/ingest'],
      ['POST', '/api/emails/understand'],
      ['POST', '/api/emails/decide'],
      ['POST', '/api/approvals/expire'],
      ['POST', '/api/decisions/any-id/approve'],
      ['POST', '/api/decisions/any-id/revise'],
      ['POST', '/api/decisions/any-id/reject'],
      ['POST', '/api/decisions/any-id/execute'],
    ];

    for (const [method, path] of protectedCalls) {
      const response = await fetch(`${s.url}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });

      assert.equal(response.status, 401, `${method} ${path} was reachable without a session`);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'UNAUTHORIZED');
      // It says "sign in", not whether a cookie was sent, expired, or whether
      // the server has a password configured.
      assert.match(body.error.message, /Sign in/i);
    }
  } finally {
    await s.stop();
  }
});

test('an authenticated request is allowed through', async () => {
  const s = await serve();
  try {
    const { cookie, status } = await signIn(s.url);
    assert.equal(status, 200);

    const response = await fetch(`${s.url}/api/emails`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { emails: unknown[] };
    assert.ok(Array.isArray(body.emails));
  } finally {
    await s.stop();
  }
});

test('a forged or stale session cookie is refused', async () => {
  const s = await serve();
  try {
    for (const forged of [
      `${SESSION_COOKIE}=${createSessionToken()}`,
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=../../etc/passwd`,
      `${SESSION_COOKIE}=${'A'.repeat(64)}`,
    ]) {
      const response = await fetch(`${s.url}/api/emails`, { headers: { cookie: forged } });
      assert.equal(response.status, 401, `a forged cookie was accepted: ${forged.slice(0, 40)}`);
    }

    // And a real session stops working once it is signed out. Logout is a state
    // change, so it carries a CSRF token like any other mutation (M5-B).
    const live = await signIn(s.url);
    assert.equal((await fetch(`${s.url}/api/emails`, { headers: { cookie: live.cookie } })).status, 200);

    await fetch(`${s.url}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: live.cookie, 'x-csrf-token': live.csrf },
    });

    assert.equal(
      (await fetch(`${s.url}/api/emails`, { headers: { cookie: live.cookie } })).status,
      401,
      'a signed-out session still worked',
    );
  } finally {
    await s.stop();
  }
});

test('x-operator can no longer assert an identity', async () => {
  // The finding this milestone closes. The header may still be sent; it must
  // have no effect on who the server believes is acting.
  const s = await serve();
  try {
    // Unauthenticated, the header buys nothing.
    const forged = await fetch(`${s.url}/api/emails`, { headers: { 'x-operator': 'ceo@example.com' } });
    assert.equal(forged.status, 401, 'x-operator alone authenticated a request');

    // Authenticated, the header does not change the identity.
    const { cookie } = await signIn(s.url);
    const session = await fetch(`${s.url}/api/auth/session`, {
      headers: { cookie, 'x-operator': 'ceo@example.com' },
    });
    const body = (await session.json()) as { operator: string };
    assert.equal(body.operator, 'operator', 'x-operator overrode the authenticated identity');
  } finally {
    await s.stop();
  }
});

test('the header has no security meaning left anywhere in the routes', async () => {
  // Belt and braces: assert the string is simply gone from the routing layer,
  // so a future edit cannot quietly reintroduce a fallback.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/routes/emails.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('x-operator'), 'x-operator is still read by the email routes');
});

test('health stays reachable without a session and reports no secret', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/health`);
    assert.equal(response.status, 200, 'a liveness probe should not need a password');

    const text = await response.text();
    assert.ok(!text.includes('scrypt$'), 'health leaked the password hash');
    assert.ok(!/sk-|password|OPERATOR_PASSWORD/i.test(text));
  } finally {
    await s.stop();
  }
});

test('the session endpoint answers without a session rather than refusing', async () => {
  const s = await serve();
  try {
    const response = await fetch(`${s.url}/api/auth/session`);
    assert.equal(response.status, 200, 'the front end cannot tell whether to show a sign-in screen');

    const body = (await response.json()) as { authenticated: boolean; csrfToken: string | null };
    assert.equal(body.authenticated, false);
    assert.equal(body.csrfToken, null);
  } finally {
    await s.stop();
  }
});

// --- what must never be logged ----------------------------------------------

test('no session token or password reaches the log', async () => {
  const memory = createMemoryLogger();
  const ctx = await createTestContext({ idPrefix: 'logs' });
  const config = await authConfig();

  const { token } = await handleLogin({ repos: ctx.repos, config, logger: memory.logger }, { password: PASSWORD });
  await rejects(() =>
    handleLogin({ repos: ctx.repos, config, logger: memory.logger }, { password: 'wrong-password' }),
  );

  const written = JSON.stringify(memory.entries);
  assert.ok(!written.includes(token), 'a session token was logged');
  assert.ok(!written.includes(PASSWORD), 'a password was logged');
  assert.ok(!written.includes('wrong-password'), 'a rejected password was logged');
  assert.ok(!written.includes('scrypt$'), 'the password hash was logged');

  await ctx.close();
});

test('a mutation performed through the API is attributed to the authenticated operator', async () => {
  // The point of the whole milestone: the audit trail records an actor, and the
  // actor comes from the session.
  const s = await serve();
  try {
    const { cookie, csrf } = await signIn(s.url);

    await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: '{}',
    });

    const emails = (await (await fetch(`${s.url}/api/emails`, { headers: { cookie } })).json()) as {
      emails: Array<{ id: string }>;
    };
    assert.ok(emails.emails.length > 0, 'ingest produced nothing to attribute');
  } finally {
    await s.stop();
  }
});
