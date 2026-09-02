import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  currentCsrfToken,
  isAuthenticated,
  needsCsrf,
  readCookie,
  sessionFromResponse,
} from '../src/auth/session.ts';
import { api, ApiError, setCsrfFailureHandler, setUnauthorizedHandler } from '../src/api/client.ts';

// M6-A — the frontend authentication layer.
//
// Tested the way this project tests frontend logic: plain modules under Node's
// own runner, with `fetch` stubbed. No jsdom, no Testing Library, no browser
// framework (NFR-9) — which is why the logic that decides *what the browser
// sends* lives in `src/auth/` and in the client, not inside JSX.
//
// The properties worth attacking here are not "does the login form render". They
// are: the password is never persisted, the session cookie is never read from
// JavaScript, every state-changing request carries the CSRF token the server
// will demand, a 401 cannot be mistaken for an empty result, and there is no
// `x-operator` fallback anywhere.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/**
 * Source with comments removed.
 *
 * The rules below are about what the code does, not what the comments say — and
 * several of these files document the very APIs they must not call. Scanning
 * raw source made a comment explaining "never write to localStorage" fail the
 * localStorage check.
 */
const code = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; credentials?: string };

let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;
let originalDocument: unknown;

/** Replies with a fixed status/body, recording exactly what the client sent. */
function stubFetch(reply: (call: Call) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    const call: Call = {
      url: String(url),
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      credentials: init?.credentials,
    };
    calls.push(call);

    const { status, body } = reply(call);
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** A fake `document.cookie`, which is the only browser API this layer touches. */
function setCookies(cookieString: string): void {
  (globalThis as { document?: unknown }).document = { cookie: cookieString };
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  originalDocument = (globalThis as { document?: unknown }).document;
  setCookies('');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as { document?: unknown }).document = originalDocument;
  setUnauthorizedHandler(null);
  setCsrfFailureHandler(null);
});

// --- cookie reading ----------------------------------------------------------

test('the CSRF cookie is read by exact name', () => {
  assert.equal(readCookie('inbox_csrf=abc123', CSRF_COOKIE), 'abc123');
  assert.equal(readCookie('other=1; inbox_csrf=abc123; more=2', CSRF_COOKIE), 'abc123');
  assert.equal(readCookie('inbox_csrf=a%20b', CSRF_COOKIE), 'a b');
  assert.equal(readCookie('', CSRF_COOKIE), null);

  // A prefix match would let a neighbouring cookie masquerade as the token.
  assert.equal(readCookie('inbox_csrf_other=nope', CSRF_COOKIE), null);
  assert.equal(readCookie('xinbox_csrf=nope', CSRF_COOKIE), null);
});

test('the session cookie is never read, because it cannot be', () => {
  // The session cookie is HttpOnly, so it is absent from document.cookie even
  // in a real browser. Nothing in this layer looks for it — asserted against
  // the source so a future edit cannot quietly start trying.
  for (const file of ['auth/session.ts', 'auth/useSession.ts', 'api/client.ts', 'screens/Login.tsx']) {
    assert.ok(!/inbox_session/.test(code(file)), `${file} refers to the HttpOnly session cookie`);
  }
});

// --- which requests need a token --------------------------------------------

test('only state-changing methods need a CSRF token', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
    assert.equal(needsCsrf(method), false, `${method} should not need CSRF`);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(needsCsrf(method), true, `${method} should need CSRF`);
  }
  assert.equal(needsCsrf(undefined), false, 'an absent method is a GET');
});

test('the current token comes from the cookie, freshly, every time', () => {
  setCookies(`${CSRF_COOKIE}=first-token`);
  assert.equal(currentCsrfToken(), 'first-token');

  // A second sign-in replaces the cookie; nothing may be cached across it.
  setCookies(`${CSRF_COOKIE}=second-token`);
  assert.equal(currentCsrfToken(), 'second-token', 'a stale token was cached');

  setCookies('');
  assert.equal(currentCsrfToken(), null);
});

// --- session state -----------------------------------------------------------

test('authentication state comes only from the server saying so', () => {
  assert.deepEqual(sessionFromResponse({ authenticated: true, operator: 'operator', expiresAt: '2026-06-01T12:00:00.000Z' }), {
    status: 'authenticated',
    operator: 'operator',
    expiresAt: '2026-06-01T12:00:00.000Z',
  });

  // Everything else resolves to anonymous. "I could not confirm you are signed
  // in" must lead to the same screen as "you are not signed in".
  for (const body of [
    { authenticated: false, operator: null, expiresAt: null, csrfToken: null },
    { authenticated: true, operator: null },
    { authenticated: true, operator: '' },
    { authenticated: 'yes', operator: 'operator' },
    { operator: 'operator' },
    {},
    null,
    undefined,
    'authenticated',
  ]) {
    assert.deepEqual(sessionFromResponse(body), { status: 'anonymous' }, `${JSON.stringify(body)} was accepted`);
  }
});

test('isAuthenticated is true for exactly one state', () => {
  assert.equal(isAuthenticated({ status: 'authenticated', operator: 'operator', expiresAt: null }), true);
  assert.equal(isAuthenticated({ status: 'anonymous' }), false);
  assert.equal(isAuthenticated({ status: 'loading' }), false);
});

// --- login -------------------------------------------------------------------

test('login posts the password to the login endpoint and nowhere else', async () => {
  stubFetch(() => ({ status: 200, body: { operator: 'operator', expiresAt: '2026-06-01T12:00:00.000Z' } }));

  const result = await api.login('a-long-enough-operator-password');

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? '', /\/api\/auth\/login$/);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { password: 'a-long-enough-operator-password' });
  assert.equal(result.operator, 'operator');

  // The password appears in the request body and nowhere else — not in the URL,
  // not in a header.
  assert.ok(!(calls[0]?.url ?? '').includes('a-long-enough'), 'the password reached the URL');
  assert.ok(
    !JSON.stringify(calls[0]?.headers).includes('a-long-enough'),
    'the password reached a header',
  );
});

test('login succeeds without a usable CSRF token, as the server exemption allows', async () => {
  // There is no session before signing in, so there can be no valid token. The
  // client still sets the header — login is a POST like any other — and the
  // server ignores it for this path (M5-B). What matters is that sign-in works
  // when the token is absent or stale, so a first visit is not a deadlock.
  setCookies('');
  stubFetch(() => ({ status: 200, body: { operator: 'operator', expiresAt: null } }));

  await api.login('pw');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers[CSRF_HEADER], undefined, 'a token was invented where none exists');

  // And with a stale token left over from a previous session.
  calls = [];
  setCookies(`${CSRF_COOKIE}=left-over-from-before`);
  await api.login('pw');
  assert.equal(calls.length, 1, 'a stale token blocked sign-in');
});

test('a wrong password surfaces as a 401 and nothing is fabricated', async () => {
  stubFetch(() => ({
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'That did not match. Check the password and try again.' } },
  }));

  const err = await api.login('wrong').then(
    () => null,
    (e: unknown) => e as ApiError,
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'UNAUTHORIZED');
});

test('a failed login does not tell the app the session ended', async () => {
  // Otherwise the sign-in screen would fight the 401 handler: type a wrong
  // password, get bounced to the sign-in screen you are already on.
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls++;
  });

  stubFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'no' } } }));
  await api.login('wrong').catch(() => undefined);

  assert.equal(unauthorizedCalls, 0, 'a failed sign-in was reported as a lost session');
});

// --- the password is never persisted ----------------------------------------

test('nothing in the auth layer writes to browser storage', () => {
  const sources = ['screens/Login.tsx', 'auth/session.ts', 'auth/useSession.ts', 'api/client.ts'];

  for (const file of sources) {
    const source = code(file);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source), `${file} persists to browser storage`);
    assert.ok(!/document\.cookie\s*=/.test(source), `${file} writes a cookie from JavaScript`);
  }

  // And the login screen clears the field on both outcomes rather than leaving
  // the password in component state after submission.
  const login = read('screens/Login.tsx');
  assert.equal(
    (login.match(/setPassword\(''\)/g) ?? []).length,
    2,
    'the password field is not cleared on both success and failure',
  );
});

// --- authenticated requests --------------------------------------------------

test('every request opts into sending cookies', async () => {
  stubFetch(() => ({ status: 200, body: { emails: [] } }));
  await api.listEmails();

  assert.equal(calls[0]?.credentials, 'same-origin', 'the session cookie would not be sent');
});

test('a state-changing request carries the CSRF header', async () => {
  setCookies(`${CSRF_COOKIE}=token-abc`);
  stubFetch(() => ({ status: 200, body: { ingested: 0, duplicates: 0 } }));

  await api.ingest();

  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.headers[CSRF_HEADER], 'token-abc', 'a mutation went out without CSRF protection');
  assert.equal(calls[0]?.headers['content-type'], 'application/json');
});

test('a read does not carry the CSRF header', async () => {
  setCookies(`${CSRF_COOKIE}=token-abc`);
  stubFetch(() => ({ status: 200, body: { emails: [] } }));

  await api.listEmails();
  assert.equal(calls[0]?.headers[CSRF_HEADER], undefined);
});

test('every mutating client method sends the token', async () => {
  setCookies(`${CSRF_COOKIE}=token-abc`);
  stubFetch(() => ({ status: 200, body: {} }));

  await api.ingest();
  await api.approve('d1').catch(() => undefined);
  await api.reject('d1', 'because').catch(() => undefined);
  await api.revise('d1', { draft: { subject: 's' } }).catch(() => undefined);
  await api.expireApprovals().catch(() => undefined);
  await api.logout().catch(() => undefined);

  assert.ok(calls.length >= 6);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers[CSRF_HEADER], 'token-abc', `${call.url} went out without CSRF protection`);
  }
});

test('logout is CSRF-protected like any other state change', async () => {
  setCookies(`${CSRF_COOKIE}=token-abc`);
  stubFetch(() => ({ status: 200, body: { signedOut: true } }));

  await api.logout();

  assert.match(calls[0]?.url ?? '', /\/api\/auth\/logout$/);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.headers[CSRF_HEADER], 'token-abc');
});

// --- 401 and CSRF failure handling ------------------------------------------

test('a 401 on a protected call tells the app the session ended, exactly once', async () => {
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls++;
  });

  stubFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } }));

  const err = await api.listEmails().then(
    () => null,
    (e: unknown) => e as ApiError,
  );

  // It still throws: a 401 must never be mistaken for an empty result.
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 401);
  assert.equal(unauthorizedCalls, 1);
});

test('the session check itself never reports a lost session', async () => {
  // `/auth/session` answers 200 for anonymous by design. Exempting it is what
  // stops a check → 401 → check loop if it ever answered otherwise.
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls++;
  });

  stubFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'no' } } }));
  await api.session().catch(() => undefined);

  assert.equal(unauthorizedCalls, 0, 'the session check could start a loop');
});

test('an anonymous session response is a normal 200, not an error', async () => {
  stubFetch(() => ({
    status: 200,
    body: { authenticated: false, operator: null, expiresAt: null, csrfToken: null },
  }));

  const body = await api.session();
  assert.equal(body.authenticated, false);
  assert.deepEqual(sessionFromResponse(body), { status: 'anonymous' });
});

test('a CSRF failure is reported separately from a lost session', async () => {
  let csrfCalls = 0;
  let unauthorizedCalls = 0;
  setCsrfFailureHandler(() => {
    csrfCalls++;
  });
  setUnauthorizedHandler(() => {
    unauthorizedCalls++;
  });

  setCookies(`${CSRF_COOKIE}=stale`);
  stubFetch(() => ({
    status: 403,
    body: {
      error: {
        code: 'FORBIDDEN',
        message: 'This request could not be verified. Reload the page and try again.',
        details: { reason: 'csrf_token_invalid' },
      },
    },
  }));

  const err = await api.ingest().then(
    () => null,
    (e: unknown) => e as ApiError,
  );

  assert.equal(csrfCalls, 1);
  assert.equal(unauthorizedCalls, 0, 'a CSRF failure was treated as a lost session');
  assert.equal(err?.status, 403);
});

test('an unrelated 403 does not trigger the CSRF path', async () => {
  let csrfCalls = 0;
  setCsrfFailureHandler(() => {
    csrfCalls++;
  });

  setCookies(`${CSRF_COOKIE}=t`);
  stubFetch(() => ({
    status: 403,
    body: { error: { code: 'FORBIDDEN', message: 'nope', details: { reason: 'origin_not_allowed' } } },
  }));

  await api.ingest().catch(() => undefined);
  assert.equal(csrfCalls, 0);
});

test('a network failure is an error, never fabricated data', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch;

  const err = await api.listEmails().then(
    () => null,
    (e: unknown) => e as ApiError,
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'NETWORK_ERROR');
});

// --- no operator header anywhere --------------------------------------------

test('the frontend never sends an operator identity', async () => {
  setCookies(`${CSRF_COOKIE}=t`);
  stubFetch(() => ({ status: 200, body: {} }));

  await api.ingest();
  await api.approve('d1').catch(() => undefined);
  await api.revise('d1', { draft: { subject: 's' } }).catch(() => undefined);

  for (const call of calls) {
    assert.equal(call.headers['x-operator'], undefined, `${call.url} sent an operator header`);
    assert.ok(!JSON.stringify(call.body).includes('editedBy'), `${call.url} supplied an editor identity`);
  }
});

test('x-operator appears nowhere in the web source', () => {
  // The header carried identity until M5-A removed its meaning. This asserts it
  // cannot creep back in through the client.
  const files = [
    'api/client.ts',
    'api/types.ts',
    'auth/session.ts',
    'auth/useSession.ts',
    'App.tsx',
    'screens/Login.tsx',
    'components/AppShell.tsx',
  ];

  for (const file of files) {
    assert.ok(!/x-operator/i.test(code(file)), `${file} still references x-operator`);
  }
});

test('the operator shown in the shell comes from the session, not from input', () => {
  const shell = code('components/AppShell.tsx');
  const app = code('App.tsx');

  // The shell takes it as a prop and renders it; App passes the value the
  // server returned.
  assert.match(shell, /operator: string;/);
  // Narrowed for the read-only demo (P19), which has no operator at all — but
  // still read from `session.state` and from nowhere else, which is the
  // property this test exists to defend.
  assert.match(
    app,
    /operator=\{session\.state\.status === 'authenticated' \? session\.state\.operator : ''\}/,
  );
  assert.ok(!/prompt\(|localStorage/.test(shell), 'the operator name came from the browser');
});

// --- the gate ----------------------------------------------------------------

test('the application is unreachable without an authenticated session', () => {
  const app = code('App.tsx');

  // Loading and anonymous both return before the shell is rendered.
  const loadingIndex = app.indexOf("status === 'loading'");
  const anonymousIndex = app.indexOf("status === 'anonymous'");
  const shellIndex = app.indexOf('<AppShell');

  assert.ok(loadingIndex > 0 && anonymousIndex > 0 && shellIndex > 0);
  assert.ok(anonymousIndex < shellIndex, 'the shell can render before the session is confirmed');
  assert.match(app, /return <Login/);
});

test('no secret or credential appears anywhere in the web source', () => {
  const files = ['api/client.ts', 'auth/session.ts', 'auth/useSession.ts', 'screens/Login.tsx', 'App.tsx'];

  for (const file of files) {
    const source = code(file);
    assert.ok(!/scrypt\$|OPERATOR_PASSWORD|DATABASE_URL|sk-ant|postgres:\/\//.test(source), `${file} contains a secret`);
    assert.ok(!/import\.meta\.env|process\.env/.test(source), `${file} reads an environment variable`);
  }
});
