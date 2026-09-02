import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTestContext } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { isPublicDemoRead, PUBLIC_DEMO_READS } from '../src/auth/middleware.ts';
import { classify, keyFor, rateLimit, RATE_LIMITS } from '../src/http/rateLimit.ts';
import type { AppConfig } from '../src/config/env.ts';

// P19 — the public read-only demo window.
//
// WHAT THIS FILE IS DEFENDING
//
// A portfolio visitor has to be able to see the product without an account.
// The way that goes wrong is not subtle — it is a flag that quietly opens more
// than it was meant to — so the tests below are written as an attacker would
// read them: not "can a visitor see the inbox?" but "what is the complete set
// of things a visitor can do, and is a mutation anywhere in it?"
//
// THE THREE PROPERTIES
//
//   1. Flag off is the old system, exactly. Every deployment that exists today
//      has this flag unset, so the default has to be indistinguishable from
//      the behaviour before this feature was written.
//   2. Flag on opens GET, and only the named GETs. Not POST on those paths,
//      not GETs that were never named, not the auth or session endpoints.
//   3. A public reader is never an operator. No session is created, so every
//      mutation fails whether or not the flag is on — the flag cannot be the
//      only thing standing between a visitor and a write.

const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;

async function baseConfig(over: Partial<AppConfig> = {}): Promise<AppConfig> {
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
  stop(): Promise<void>;
};

async function serve(over: Partial<AppConfig> = {}, limiter?: ReturnType<typeof rateLimit>): Promise<Server> {
  const ctx = await createTestContext({ idPrefix: 'p19' });
  const config = await baseConfig(over);
  const app = createApp({
    db: ctx.db,
    config,
    logger: quiet,
    ...(limiter ? { rateLimiter: limiter } : {}),
  });

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

async function signIn(url: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const setCookie = response.headers.getSetCookie();
  const session = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
  const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`, csrf: csrf ?? '' };
}

/** The endpoints the demo is allowed to answer without a session. */
const PUBLIC_READS = [
  '/api/emails',
  '/api/approvals',
  '/api/deals',
  '/api/contacts',
  '/api/companies',
  '/api/tasks',
  '/api/audit',
];

/** A listed path whose row genuinely does not exist, so a 404 is the handler. */
const PUBLIC_READ_MISSING_ROW = '/api/emails/does-not-exist';

/**
 * Every mutating endpoint in the product.
 *
 * Enumerated by hand from `routes/emails.ts` rather than derived, for the same
 * reason the allow-list is a literal: a derived list would grow a hole at the
 * same moment the router did.
 */
const MUTATIONS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/emails/ingest' },
  { method: 'POST', path: '/api/emails/understand' },
  { method: 'POST', path: '/api/emails/resolve' },
  { method: 'POST', path: '/api/emails/decide' },
  { method: 'POST', path: '/api/emails/e1/understand' },
  { method: 'POST', path: '/api/emails/e1/resolve' },
  { method: 'POST', path: '/api/emails/e1/decide' },
  { method: 'POST', path: '/api/emails/e1/resolve-match', body: { companyId: 'c1' } },
  { method: 'POST', path: '/api/approvals/expire' },
  { method: 'POST', path: '/api/decisions/d1/approve' },
  { method: 'POST', path: '/api/decisions/d1/reject', body: { reason: 'no' } },
  { method: 'POST', path: '/api/decisions/d1/execute' },
  { method: 'POST', path: '/api/decisions/d1/retry' },
  { method: 'POST', path: '/api/decisions/d1/revise', body: { edits: [] } },
];

// --- property 1: the flag is off by default, and off means unchanged ---------

test('the flag defaults to false, so an environment that says nothing stays private', async () => {
  const { config } = loadConfig({});
  assert.equal(config.demoPublicReadonly, false);
});

test('an explicit false is still false, and only the literal true opens it', async () => {
  assert.equal(loadConfig({ DEMO_PUBLIC_READONLY: 'false' }).config.demoPublicReadonly, false);
  assert.equal(loadConfig({ DEMO_PUBLIC_READONLY: 'no' }).config.demoPublicReadonly, false);
  assert.equal(loadConfig({ DEMO_PUBLIC_READONLY: '' }).config.demoPublicReadonly, false);
  assert.equal(loadConfig({ DEMO_PUBLIC_READONLY: 'true' }).config.demoPublicReadonly, true);
});

test('with the flag off every read is refused exactly as before', async () => {
  const server = await serve({ demoPublicReadonly: false });

  for (const path of [...PUBLIC_READS, PUBLIC_READ_MISSING_ROW]) {
    const response = await fetch(`${server.url}${path}`);
    assert.equal(response.status, 401, `${path} answered ${response.status} without a session`);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  }

  await server.stop();
});

// --- property 2: on opens the named GETs, and nothing beyond them ------------

test('with the flag on the named reads answer without a session', async () => {
  const server = await serve({ demoPublicReadonly: true });

  // Strictly 200. An earlier version of this test accepted "200 or 404" so that
  // a missing row would not fail it, and that tolerance hid a real bug: the
  // allow-list named `/crm/deals`, a path this server does not have, so every
  // CRM read 404'd straight through the gate and the test still passed. A
  // listed read that cannot return data is a broken list, and it fails here.
  for (const path of PUBLIC_READS) {
    const response = await fetch(`${server.url}${path}`);
    assert.equal(response.status, 200, `${path} answered ${response.status}, not 200`);
  }

  // The one legitimate 404: a well-formed read for a row that is not there. It
  // proves the request reached a handler, because the gate never reaches one.
  const missing = await fetch(`${server.url}${PUBLIC_READ_MISSING_ROW}`);
  assert.equal(missing.status, 404);

  await server.stop();
});

test('the demo window does not extend to endpoints nobody named', async () => {
  const server = await serve({ demoPublicReadonly: true });

  // Shapes adjacent to the allow-list: a deeper path under a listed prefix, a
  // sibling that was never listed, and a CRM name outside the enumerated set.
  for (const path of [
    '/api/emails/e1/decision',
    '/api/decisions/d1',
    '/api/crm/deals',
    '/api/notes',
    '/api/deals/extra',
    '/api/outbox',
  ]) {
    const response = await fetch(`${server.url}${path}`);
    assert.ok(
      response.status === 401 || response.status === 404,
      `${path} answered ${response.status}; an unnamed path must never be served`,
    );
    if (response.status === 401) continue;
    // A 404 here must be the API's own catch-all, not a handler's answer —
    // either way no data left the server.
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'NOT_FOUND');
  }

  await server.stop();
});

test('the allow-list matches GET only, so the same paths reject other verbs', () => {
  for (const path of ['/emails', '/emails/e1', '/approvals', '/deals', '/audit']) {
    assert.equal(isPublicDemoRead('GET', path), true, `${path} should be a public read`);
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal(isPublicDemoRead(verb, path), false, `${verb} ${path} must not be public`);
    }
  }
});

test('the allow-list is anchored and cannot be widened by a crafted path', () => {
  for (const path of [
    '/emails/e1/approve',
    '/emails/e1/decision',
    '/deals/1',
    '/notes',
    '/crm/deals',
    '/emailsX',
    '/x/emails',
    '/approvals/1',
    '/crm/deals?x=1/../../emails',
  ]) {
    assert.equal(isPublicDemoRead('GET', path), false, `${path} must not match the allow-list`);
  }

  // The list is short and literal on purpose; if it grows, that is a decision
  // somebody made, and this assertion is where they are asked to confirm it.
  assert.equal(PUBLIC_DEMO_READS.length, 4);
});

// --- property 3: a public reader is never an operator ------------------------

test('every mutation stays refused with the demo window wide open', async () => {
  const server = await serve({ demoPublicReadonly: true });

  for (const mutation of MUTATIONS) {
    const response = await fetch(`${server.url}${mutation.path}`, {
      method: mutation.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation.body ?? {}),
    });

    assert.equal(
      response.status,
      401,
      `${mutation.method} ${mutation.path} answered ${response.status} with no session`,
    );
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  }

  await server.stop();
});

test('a public reader cannot mutate by presenting a CSRF token it minted itself', async () => {
  const server = await serve({ demoPublicReadonly: true });

  const response = await fetch(`${server.url}/api/emails/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'made-up-token' },
    body: '{}',
  });

  assert.equal(response.status, 401);
  await server.stop();
});

test('the demo window issues no cookie, so reading never becomes a session', async () => {
  const server = await serve({ demoPublicReadonly: true });

  const response = await fetch(`${server.url}/api/emails`);
  assert.equal(response.headers.getSetCookie().length, 0, 'a read handed out a cookie');

  const session = await (await fetch(`${server.url}/api/auth/session`)).json();
  assert.equal((session as { authenticated: boolean }).authenticated, false);
  assert.equal((session as { operator: string | null }).operator, null);

  await server.stop();
});

test('an x-operator header is still not identity, with the window open', async () => {
  const server = await serve({ demoPublicReadonly: true });

  const response = await fetch(`${server.url}/api/emails/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-operator': 'sameer' },
    body: '{}',
  });

  assert.equal(response.status, 401, 'a header granted access the session did not');
  await server.stop();
});

test('signing in still works and still authorises mutations', async () => {
  const server = await serve({ demoPublicReadonly: true });
  const { cookie, csrf } = await signIn(server.url);

  const response = await fetch(`${server.url}/api/emails/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: '{}',
  });

  assert.notEqual(response.status, 401, 'a real operator was refused');
  await server.stop();
});

// --- the flag is visible from outside ---------------------------------------

test('health reports whether the demo window is open, in both states', async () => {
  const open = await serve({ demoPublicReadonly: true });
  const openBody = (await (await fetch(`${open.url}/api/health`)).json()) as {
    adapters: Record<string, unknown>;
  };
  assert.equal(openBody.adapters.demoPublicReadonly, true);
  await open.stop();

  const shut = await serve({ demoPublicReadonly: false });
  const shutBody = (await (await fetch(`${shut.url}/api/health`)).json()) as {
    adapters: Record<string, unknown>;
  };
  assert.equal(shutBody.adapters.demoPublicReadonly, false);
  await shut.stop();
});

test('health still carries no secret, with the window open', async () => {
  const server = await serve({ demoPublicReadonly: true });
  const raw = await (await fetch(`${server.url}/api/health`)).text();

  assert.ok(!raw.includes(PASSWORD), 'the password appeared in health');
  assert.ok(!raw.toLowerCase().includes('scrypt$'), 'a password hash appeared in health');

  await server.stop();
});

// --- rate limiting, and one honest gap -------------------------------------

test('the limiter still classes every mutation, with the demo window open', () => {
  // The gate does not touch the limiter, and the limiter runs above the gate,
  // so an anonymous mutation is counted before it is refused.
  for (const path of [
    '/emails/ingest',
    '/emails/e1/resolve-match',
    '/approvals/expire',
    '/decisions/d1/approve',
    '/decisions/d1/retry',
  ]) {
    assert.notEqual(classify('POST', path), null, `POST ${path} is not rate limited`);
  }

  assert.equal(classify('POST', '/emails/understand'), 'expensive');
  assert.equal(classify('POST', '/auth/login'), 'login');
});

test('an anonymous caller is bucketed by IP, never shared with a session', () => {
  const anonymous = keyFor({ ip: '203.0.113.9' } as never);
  assert.equal(anonymous, 'ip:203.0.113.9');

  const signedIn = keyFor({ ip: '203.0.113.9', session: { tokenHash: 'abc' } } as never);
  assert.equal(signedIn, 'session:abc');
  assert.notEqual(anonymous, signedIn);
});

test('reads stay unlimited everywhere except the open public demo', () => {
  const reads = ['/emails', '/emails/e1', '/approvals', '/deals', '/contacts', '/companies', '/tasks', '/audit'];

  // The pre-P19 answer, which every existing caller and test depends on: a bare
  // two-argument call classes no read at all.
  for (const path of reads) {
    assert.equal(classify('GET', path), null, `GET ${path} is limited with no context`);
  }

  // Window shut: unchanged, so an existing deployment sees no new 429s.
  for (const path of reads) {
    assert.equal(classify('GET', path, { publicReadsEnabled: false }), null);
  }

  // Window open, but the caller is a signed-in operator: their dashboard keeps
  // the unlimited reads it has always had.
  for (const path of reads) {
    assert.equal(
      classify('GET', path, { publicReadsEnabled: true, authenticated: true }),
      null,
      `GET ${path} started limiting an authenticated operator`,
    );
  }

  // Window open and the caller is anonymous: this, and only this, is limited.
  for (const path of reads) {
    assert.equal(
      classify('GET', path, { publicReadsEnabled: true, authenticated: false }),
      'publicRead',
      `GET ${path} is unlimited while facing the internet`,
    );
  }
});

test('limiting a read never implies the read is public', () => {
  // A GET that is not on the allow-list stays unclassed even with the window
  // open — the limiter must not become a second, looser definition of public.
  for (const path of ['/emails/e1/decision', '/decisions/d1', '/notes', '/deals/1', '/crm/deals', '/outbox']) {
    assert.equal(
      classify('GET', path, { publicReadsEnabled: true, authenticated: false }),
      null,
      `GET ${path} was classed publicRead but is not on the allow-list`,
    );
    assert.equal(isPublicDemoRead('GET', path), false);
  }
});

test('the demo window never reclassifies a mutation', () => {
  // Opening the read window must not move a write out of its class, or a
  // mutation would inherit the looser read budget.
  for (const path of ['/emails/ingest', '/approvals/expire', '/decisions/d1/approve', '/decisions/d1/retry']) {
    const shut = classify('POST', path, { publicReadsEnabled: false, authenticated: false });
    const open = classify('POST', path, { publicReadsEnabled: true, authenticated: false });
    assert.equal(open, shut, `POST ${path} changed class when the window opened`);
    assert.equal(open, 'mutation');
  }

  assert.equal(classify('POST', '/emails/understand', { publicReadsEnabled: true }), 'expensive');
  assert.equal(classify('POST', '/auth/login', { publicReadsEnabled: true }), 'login');
});

test('the public read budget is a real number, looser than expensive and tighter than mutation', () => {
  assert.equal(RATE_LIMITS.publicRead.windowMs, 60_000);
  assert.ok(RATE_LIMITS.publicRead.limit > RATE_LIMITS.expensive.limit);
  assert.ok(RATE_LIMITS.publicRead.limit < RATE_LIMITS.mutation.limit);
});

// --- state is not merely un-mutated by policy, but in fact ------------------

test('a full mutation sweep from a public reader leaves the data untouched', async () => {
  const server = await serve({ demoPublicReadonly: true });

  const snapshot = async (): Promise<string> => {
    const parts: string[] = [];
    for (const path of PUBLIC_READS) {
      parts.push(await (await fetch(`${server.url}${path}`)).text());
    }
    return parts.join('\u0000');
  };

  const before = await snapshot();

  for (const mutation of MUTATIONS) {
    await fetch(`${server.url}${mutation.path}`, {
      method: mutation.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation.body ?? {}),
    });
  }

  assert.equal(await snapshot(), before, 'the readable state changed after a mutation sweep');
  await server.stop();
});


// --- the limiter, over real HTTP -------------------------------------------

/** A limiter with a tiny public-read budget, so exhaustion is observable. */
function tinyReadLimiter(publicReadsEnabled: boolean) {
  return rateLimit({
    publicReadsEnabled,
    limits: {
      login: { limit: 1000, windowMs: 60_000 },
      expensive: { limit: 1000, windowMs: 60_000 },
      mutation: { limit: 1000, windowMs: 60_000 },
      publicRead: { limit: 3, windowMs: 60_000 },
    },
  });
}

test('with the window open an anonymous reader is cut off after its budget', async () => {
  const server = await serve({ demoPublicReadonly: true }, tinyReadLimiter(true));

  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await fetch(`${server.url}/api/emails`)).status);
  }

  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'a visitor was refused inside the budget');
  assert.equal(statuses[3], 429, 'the fourth request was not refused');
  assert.equal(statuses[4], 429);

  const refused = await fetch(`${server.url}/api/emails`);
  assert.ok(refused.headers.get('retry-after'), 'a 429 carried no Retry-After');
  assert.ok(refused.headers.get('x-ratelimit-limit'), 'a 429 carried no limit header');

  await server.stop();
});

test('all eight approved reads share the limiter, and each is subject to it', async () => {
  for (const path of PUBLIC_READS) {
    const server = await serve({ demoPublicReadonly: true }, tinyReadLimiter(true));

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(`${server.url}${path}`)).status);
    }

    assert.equal(statuses[0], 200, `${path} did not answer`);
    assert.equal(statuses[3], 429, `${path} is not rate limited`);

    await server.stop();
  }
});

test('with the window shut a read is refused, never throttled', async () => {
  const server = await serve({ demoPublicReadonly: false }, tinyReadLimiter(false));

  // Well past the tiny budget. Every one must be the 401 today's deployment
  // returns — a 429 here would be a behaviour change for an existing install.
  for (let i = 0; i < 6; i++) {
    const response = await fetch(`${server.url}/api/emails`);
    assert.equal(response.status, 401, `request ${i + 1} answered ${response.status}`);
  }

  await server.stop();
});

test('an authenticated operator is never throttled on reads', async () => {
  const server = await serve({ demoPublicReadonly: true }, tinyReadLimiter(true));
  const { cookie } = await signIn(server.url);

  // Ten reads, well past the anonymous budget of three.
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${server.url}/api/emails`, { headers: { cookie } });
    assert.equal(response.status, 200, `operator read ${i + 1} answered ${response.status}`);
  }

  await server.stop();
});

test('separate client addresses get separate buckets', async () => {
  const server = await serve({ demoPublicReadonly: true, trustProxy: 1 }, tinyReadLimiter(true));

  const get = (ip: string) =>
    fetch(`${server.url}/api/emails`, { headers: { 'x-forwarded-for': ip } }).then((r) => r.status);

  // Exhaust one visitor.
  for (let i = 0; i < 3; i++) assert.equal(await get('203.0.113.1'), 200);
  assert.equal(await get('203.0.113.1'), 429, 'the first visitor was not exhausted');

  // A different visitor is unaffected.
  assert.equal(await get('198.51.100.7'), 200, 'a second visitor inherited the first bucket');

  await server.stop();
});

test('throttling a reader never lets a mutation through', async () => {
  const server = await serve({ demoPublicReadonly: true }, tinyReadLimiter(true));

  // Exhaust the read budget first, so the limiter is actively refusing.
  for (let i = 0; i < 5; i++) await fetch(`${server.url}/api/emails`);

  for (const mutation of MUTATIONS) {
    const response = await fetch(`${server.url}${mutation.path}`, {
      method: mutation.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation.body ?? {}),
    });

    // 401 specifically, not 429: the gate must be what refuses a write, so that
    // an exhausted limiter can never read as "authorised but busy".
    assert.equal(
      response.status,
      401,
      `${mutation.method} ${mutation.path} answered ${response.status} while reads were throttled`,
    );
  }

  await server.stop();
});
