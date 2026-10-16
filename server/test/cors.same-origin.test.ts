import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTestContext } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { isOwnOrigin } from '../src/http/cors.ts';

// A browser sends an `Origin` header on a same-origin POST. With an empty CORS
// allow-list the server used to treat that as a foreign origin and answer 403, so
// signing in to the dashboard it serves failed. These tests send the `Origin` a
// browser sends, which no earlier test did.

const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;

type Server = { url: string; stop(): Promise<void> };

async function serve(over: Partial<AppConfig> = {}): Promise<Server> {
  const ctx = await createTestContext({ idPrefix: 'cors' });
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
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

function signIn(url: string, origin?: string): Promise<Response> {
  return fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ password: PASSWORD }),
  });
}

test('isOwnOrigin compares scheme, host and port, ignoring case', () => {
  assert.equal(isOwnOrigin('http://localhost:3100', 'http://localhost:3100'), true);
  assert.equal(isOwnOrigin('HTTP://LocalHost:3100', 'http://localhost:3100'), true);
  assert.equal(isOwnOrigin('http://localhost:3101', 'http://localhost:3100'), false);
  assert.equal(isOwnOrigin('https://localhost:3100', 'http://localhost:3100'), false);
  assert.equal(isOwnOrigin(undefined, 'http://localhost:3100'), false);
  assert.equal(isOwnOrigin('http://localhost:3100', undefined), false);
});

test('sign-in from the server\'s own origin passes with an empty allow-list', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    const response = await signIn(s.url, s.url);
    assert.equal(response.status, 200, 'the dashboard could not sign in to the server that serves it');
    assert.ok(response.headers.getSetCookie().length > 0, 'no session cookie was issued');
    // Same-origin needs no CORS headers, and none should be advertised for it.
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.stop();
  }
});

test('sign-in from a foreign origin is refused, and no session is issued', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    const response = await signIn(s.url, 'https://evil.example');
    assert.equal(response.status, 403);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.stop();
  }
});

test('sign-in with no Origin header (a script or curl) passes', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    assert.equal((await signIn(s.url)).status, 200);
  } finally {
    await s.stop();
  }
});

test('an origin that differs only in port or scheme is a foreign origin', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    const other = s.url.replace(/:\d+$/, (m) => `:${Number(m.slice(1)) + 1}`);
    assert.equal((await signIn(s.url, other)).status, 403, 'a different port was treated as the same origin');
    assert.equal((await signIn(s.url, s.url.replace('http://', 'https://'))).status, 403, 'a different scheme was treated as the same origin');
  } finally {
    await s.stop();
  }
});

test('a mutation from the own origin still needs the CSRF token', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    const login = await signIn(s.url, s.url);
    const setCookie = login.headers.getSetCookie();
    const token = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
    const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
    const post = (headers: Record<string, string>) =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: s.url, cookie, ...headers },
        body: '{}',
      });

    assert.equal((await post({ [CSRF_HEADER]: csrf })).status, 200);
    assert.equal((await post({})).status, 403, 'a same-origin request skipped the CSRF check');
  } finally {
    await s.stop();
  }
});

test('a listed foreign origin still gets credentialed CORS, and the own origin still needs none', async () => {
  const listed = 'https://app.example.com';
  const s = await serve({ corsAllowedOrigins: [listed] });
  try {
    const foreign = await signIn(s.url, listed);
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers.get('access-control-allow-origin'), listed);
    assert.equal(foreign.headers.get('access-control-allow-credentials'), 'true');

    const own = await signIn(s.url, s.url);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.stop();
  }
});

test('a preflight from a foreign origin is still refused with an empty allow-list', async () => {
  const s = await serve({ corsAllowedOrigins: [] });
  try {
    const response = await fetch(`${s.url}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(response.status, 403);
  } finally {
    await s.stop();
  }
});
