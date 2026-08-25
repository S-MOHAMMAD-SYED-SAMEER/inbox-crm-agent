import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTestContext } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import {
  FixedWindowLimiter,
  classify,
  rateLimit,
  RATE_LIMITS,
  type RateLimitClass,
  type RateLimitRule,
} from '../src/http/rateLimit.ts';
import type { AppConfig } from '../src/config/env.ts';
import type { Clock } from '../src/lib/clock.ts';

// M5-C — rate limiting.
//
// The limiter is in-memory and single-process. It is a guard against runaway
// scripts and accidents, and against an unauthenticated stranger driving the
// endpoints that call a model — which is spend, not merely load. It is NOT
// distributed rate limiting, and nothing here claims it is.
//
// The two properties worth attacking directly: a header cannot move a caller
// into a fresh bucket, and the health endpoint is never throttled.

const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;

/** A clock the test moves by hand, so window resets are deterministic. */
function movableClock(startIso: string): Clock & { advance(ms: number): void } {
  let now = Date.parse(startIso);
  return {
    nowIso: () => new Date(now).toISOString(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const TINY: Record<RateLimitClass, RateLimitRule> = {
  login: { limit: 3, windowMs: 60_000 },
  expensive: { limit: 2, windowMs: 60_000 },
  mutation: { limit: 4, windowMs: 60_000 },
};

type Server = {
  url: string;
  cookie: string;
  csrf: string;
  advance(ms: number): void;
  stop(): Promise<void>;
};

async function serve(over: Partial<AppConfig> = {}): Promise<Server> {
  const ctx = await createTestContext({ idPrefix: 'm5c' });
  const clock = movableClock('2026-06-01T00:00:00.000Z');

  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    ...over,
  };

  const app = createApp({
    db: ctx.db,
    config,
    logger: quiet,
    rateLimiter: rateLimit({ limiter: new FixedWindowLimiter(clock), limits: TINY }),
  });

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
    advance: clock.advance,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

// --- the limiter as a unit ---------------------------------------------------

test('a fixed window allows up to the limit and refuses beyond it', () => {
  const clock = movableClock('2026-06-01T00:00:00.000Z');
  const limiter = new FixedWindowLimiter(clock);
  const rule = { limit: 3, windowMs: 60_000 };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const decision = limiter.check('k', rule);
    assert.equal(decision.allowed, true, `request ${attempt} was refused`);
    assert.equal(decision.remaining, 3 - attempt);
  }

  const refused = limiter.check('k', rule);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterSeconds > 0, 'a refusal must say when to come back');
});

test('a window resets, and only after it has actually elapsed', () => {
  const clock = movableClock('2026-06-01T00:00:00.000Z');
  const limiter = new FixedWindowLimiter(clock);
  const rule = { limit: 2, windowMs: 60_000 };

  limiter.check('k', rule);
  limiter.check('k', rule);
  assert.equal(limiter.check('k', rule).allowed, false);

  clock.advance(59_999);
  assert.equal(limiter.check('k', rule).allowed, false, 'the window reset early');

  clock.advance(1);
  assert.equal(limiter.check('k', rule).allowed, true, 'the window never reset');
});

test('separate keys are isolated', () => {
  const limiter = new FixedWindowLimiter(movableClock('2026-06-01T00:00:00.000Z'));
  const rule = { limit: 1, windowMs: 60_000 };

  assert.equal(limiter.check('a', rule).allowed, true);
  assert.equal(limiter.check('a', rule).allowed, false);
  assert.equal(limiter.check('b', rule).allowed, true, 'one client exhausted another\'s budget');
});

test('expired windows are pruned, so the map cannot grow forever', () => {
  const clock = movableClock('2026-06-01T00:00:00.000Z');
  const limiter = new FixedWindowLimiter(clock);
  const rule = { limit: 5, windowMs: 60_000 };

  for (let i = 0; i < 100; i++) limiter.check(`ip:${i}`, rule);
  assert.equal(limiter.size, 100);

  assert.equal(limiter.prune(), 0, 'live windows were pruned');
  clock.advance(60_001);
  assert.equal(limiter.prune(), 100);
  assert.equal(limiter.size, 0);
});

test('classification puts model-calling endpoints in the expensive bucket', () => {
  assert.equal(classify('POST', '/auth/login'), 'login');

  for (const path of ['/emails/understand', '/emails/abc/understand', '/emails/decide', '/emails/abc/decide']) {
    assert.equal(classify('POST', path), 'expensive', `${path} is not treated as expensive`);
  }

  assert.equal(classify('POST', '/emails/ingest'), 'mutation');
  assert.equal(classify('POST', '/decisions/abc/approve'), 'mutation');

  // Reads are unlimited: a busy dashboard is not an attack.
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(classify(method, '/emails'), null);
    assert.equal(classify(method, '/health'), null);
  }
});

test('the shipped limits are tightest where spend happens', () => {
  assert.ok(
    RATE_LIMITS.expensive.limit < RATE_LIMITS.mutation.limit,
    'model-calling endpoints are not limited more tightly than ordinary writes',
  );
  assert.ok(RATE_LIMITS.login.limit <= RATE_LIMITS.expensive.limit);
});

// --- over HTTP ---------------------------------------------------------------

test('requests below the limit succeed and exceeding it returns 429 with Retry-After', async () => {
  const s = await serve();
  try {
    const send = () =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
        body: '{}',
      });

    for (let attempt = 1; attempt <= TINY.mutation.limit; attempt++) {
      const response = await send();
      assert.equal(response.status, 200, `request ${attempt} was refused below the limit`);
      assert.equal(response.headers.get('x-ratelimit-limit'), String(TINY.mutation.limit));
    }

    const refused = await send();
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0, 'no Retry-After on a 429');

    const body = (await refused.json()) as { error: { code: string; message: string; details?: unknown } };
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.deepEqual(body.error.details, { retryAfterSeconds: 60 });
  } finally {
    await s.stop();
  }
});

test('the window resets over HTTP too', async () => {
  const s = await serve();
  try {
    const send = () =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
        body: '{}',
      });

    for (let i = 0; i < TINY.mutation.limit; i++) await send();
    assert.equal((await send()).status, 429);

    s.advance(60_001);
    assert.equal((await send()).status, 200, 'the window never reopened');
  } finally {
    await s.stop();
  }
});

test('an unauthenticated login is limited by IP', async () => {
  const s = await serve();
  try {
    const attempt = () =>
      fetch(`${s.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });

    // One login already happened in `serve`, so the budget is one short.
    let refused = 0;
    for (let i = 0; i < TINY.login.limit + 2; i++) {
      if ((await attempt()).status === 429) refused++;
    }

    assert.ok(refused > 0, 'password guessing was never rate limited');
  } finally {
    await s.stop();
  }
});

test('an expensive operation is limited more tightly than an ordinary mutation', async () => {
  const s = await serve();
  try {
    const expensive = () =>
      fetch(`${s.url}/api/emails/understand`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
        body: '{}',
      });

    for (let i = 0; i < TINY.expensive.limit; i++) {
      assert.notEqual((await expensive()).status, 429, `expensive request ${i + 1} was refused early`);
    }
    assert.equal((await expensive()).status, 429, 'model-calling endpoints were not limited');

    // The mutation bucket is separate and still has budget.
    const ordinary = await fetch(`${s.url}/api/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
      body: '{}',
    });
    assert.equal(ordinary.status, 200, 'exhausting one class exhausted another');
  } finally {
    await s.stop();
  }
});

test('no request header can move a caller into a fresh bucket', async () => {
  // The key is derived server-side from the session or the socket. `x-operator`
  // was the reason F-01 existed; it must not be able to reset a budget either.
  const s = await serve();
  try {
    const send = (headers: Record<string, string>) =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf, ...headers },
        body: '{}',
      });

    for (let i = 0; i < TINY.mutation.limit; i++) await send({});
    assert.equal((await send({})).status, 429);

    const forgeries: Array<Record<string, string>> = [
      { 'x-operator': 'someone-else' },
      { 'x-forwarded-for': '10.0.0.99' },
      { 'x-real-ip': '10.0.0.98' },
      { 'x-operator': 'admin', 'x-forwarded-for': '203.0.113.5' },
    ];

    for (const forged of forgeries) {
      const response = await send(forged);
      assert.equal(response.status, 429, `headers ${JSON.stringify(forged)} bypassed the limit`);
    }
  } finally {
    await s.stop();
  }
});

test('two sessions get separate budgets', async () => {
  const s = await serve();
  try {
    const second = await fetch(`${s.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = second.headers.getSetCookie();
    const token = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
    const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';
    const secondCookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

    const send = (cookie: string, csrfToken: string) =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, [CSRF_HEADER]: csrfToken },
        body: '{}',
      });

    for (let i = 0; i < TINY.mutation.limit; i++) await send(s.cookie, s.csrf);
    assert.equal((await send(s.cookie, s.csrf)).status, 429);

    // A different session has its own budget. Keying on the operator name would
    // have put both in one bucket, since there is only ever one operator.
    assert.equal((await send(secondCookie, csrf)).status, 200, 'sessions shared a bucket');
  } finally {
    await s.stop();
  }
});

test('health is never rate limited', async () => {
  const s = await serve();
  try {
    // Far beyond every configured limit. A monitor asking "are you alive?" must
    // not be the thing that gets throttled.
    for (let i = 0; i < 50; i++) {
      const response = await fetch(`${s.url}/api/health`);
      assert.equal(response.status, 200, `health was throttled on request ${i + 1}`);
    }
  } finally {
    await s.stop();
  }
});

test('a rate-limit refusal describes nothing about the caller or the system', async () => {
  const s = await serve();
  try {
    const send = () =>
      fetch(`${s.url}/api/emails/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: s.cookie, [CSRF_HEADER]: s.csrf },
        body: '{}',
      });

    for (let i = 0; i < TINY.mutation.limit; i++) await send();
    const refused = await send();
    const text = await refused.text();

    assert.ok(!text.includes(s.csrf), 'the refusal echoed a CSRF token');
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!/scrypt\$|sk-|inbox_session|session:|ip:/.test(text), 'the refusal described its bucket');
    assert.ok(!/127\.0\.0\.1|::1/.test(text), 'the refusal echoed the caller address');
  } finally {
    await s.stop();
  }
});
