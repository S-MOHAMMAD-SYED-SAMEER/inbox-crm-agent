import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { rateLimit } from '../src/http/rateLimit.ts';
import { createTestContext } from './helpers.ts';
import { hashPassword } from '../src/lib/password.ts';
import { readCookie, SESSION_COOKIE } from '../src/auth/cookies.ts';
import type { AppConfig } from '../src/config/env.ts';

// M7-A — deployment enablement.
//
// Two changes, both of them plumbing rather than product: the API serves the
// built front end from its own origin, and the app is told how many proxies
// stand in front of it. Neither touches a safety boundary. The second one
// PROTECTS a safety boundary that would otherwise break silently the moment the
// app moved behind a managed host, which is why most of this file is about it.

// --- a throwaway `dist/` -----------------------------------------------------
//
// Built from scratch rather than depending on `npm run build` having been run:
// a test that only passes after a build is a test that fails in CI for reasons
// unrelated to what it is checking.

function makeDist(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm7a-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><title>Inbox-to-CRM</title><div id="root"></div><script src="/assets/index-abc123.js"></script>',
  );
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("app");');
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

type ServerOptions = {
  trustProxy?: number;
  webDistDir?: string;
  loginLimit?: number;
  /** Set to make sign-in possible, for the one test that needs to be past the gate. */
  operatorPassword?: string;
};

async function withServer(
  options: ServerOptions,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const ctx = await createTestContext();
  const base = loadConfig({}).config;
  const config: AppConfig = {
    ...base,
    trustProxy: options.trustProxy ?? 0,
    webDistDir: options.webDistDir ?? path.join(os.tmpdir(), 'm7a-absent-dist'),
    cookieSecure: false,
    ...(options.operatorPassword ? { operatorPasswordHash: await hashPassword(options.operatorPassword) } : {}),
  };

  // A login limit of 1 makes bucket identity directly observable: the second
  // request in a bucket is refused, so 429 means "same bucket as the first" and
  // 401 means "a different one". Far more precise than sending ten requests and
  // inferring.
  const rateLimiter = rateLimit({
    limits: {
      login: { limit: options.loginLimit ?? 1, windowMs: 60_000 },
      expensive: { limit: 1000, windowMs: 60_000 },
      mutation: { limit: 1000, windowMs: 60_000 },
    },
  });

  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger, rateLimiter });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

/** One sign-in attempt from a claimed forwarding chain. */
async function login(baseUrl: string, forwardedFor?: string): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'not-the-password' }),
  });
  return response.status;
}

// ============================================== the front end, same origin

test('the built front end is served by the API server', async () => {
  const dist = makeDist();
  try {
    await withServer({ webDistDir: dist.dir }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(body, /<div id="root">/);
    });
  } finally {
    dist.cleanup();
  }
});

test('hashed assets are served beside it', async () => {
  const dist = makeDist();
  try {
    await withServer({ webDistDir: dist.dir }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/assets/index-abc123.js`);

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /javascript/);
      assert.match(await response.text(), /console\.log/);
    });
  } finally {
    dist.cleanup();
  }
});

test('the API still answers, and the front end cannot shadow it', async () => {
  const dist = makeDist();
  const password = 'm7a-operator-password-1234';
  try {
    await withServer({ webDistDir: dist.dir, operatorPassword: password, loginLimit: 50 }, async (baseUrl) => {
      // Health is public and must stay JSON even with static serving mounted.
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
      assert.match(health.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(((await health.json()) as { status: string }).status, 'ok');

      // Unauthenticated, an unknown API path is refused by the gate rather than
      // described. `requireSession` sits above the API's 404, so a stranger
      // learns nothing about which endpoints exist — and, the part this test is
      // really about, gets JSON rather than the front end's index.html.
      const anonymous = await fetch(`${baseUrl}/api/does-not-exist`);
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.headers.get('content-type') ?? '', /application\/json/);

      // Signed in, the API's own 404 answers — proving the catch-all still
      // fires below the static mount rather than falling through to the app.
      const signIn = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      assert.equal(signIn.status, 200);
      const token =
        signIn.headers
          .getSetCookie()
          .map((raw) => readCookie(raw.split(';')[0], SESSION_COOKIE))
          .find(Boolean) ?? '';
      assert.ok(token, 'no session cookie was issued');

      const missing = await fetch(`${baseUrl}/api/does-not-exist`, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      });
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
    });
  } finally {
    dist.cleanup();
  }
});

test('a protected API route is still protected with the front end mounted', async () => {
  const dist = makeDist();
  try {
    await withServer({ webDistDir: dist.dir }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/emails`);
      assert.equal(response.status, 401, 'serving static files opened a hole in the gate');
    });
  } finally {
    dist.cleanup();
  }
});

test('no SPA fallback exists, because a hash router needs none', async () => {
  // Every route the client has is a fragment — `/#/inbox`, `/#/deals` — and a
  // fragment is never sent to a server. The only path a browser requests is `/`
  // and the assets beside it, so a history-API fallback would be answering a
  // question this front end never asks, at the cost of turning every genuine
  // 404 into a 200 serving the app.
  const dist = makeDist();
  try {
    await withServer({ webDistDir: dist.dir }, async (baseUrl) => {
      const unknown = await fetch(`${baseUrl}/deals`);
      assert.notEqual(unknown.status, 200, 'an unknown path returned the app, which a hash router never needs');

      // And the hash route itself resolves, because the server only ever sees `/`.
      const hashRoute = await fetch(`${baseUrl}/#/deals`);
      assert.equal(hashRoute.status, 200);
      assert.match(await hashRoute.text(), /<div id="root">/);
    });
  } finally {
    dist.cleanup();
  }
});

test('a missing dist directory leaves the API working', async () => {
  // The normal state in development, where Vite serves the front end, and under
  // test. `express.static` calls next() rather than throwing.
  await withServer({}, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);

    const root = await fetch(`${baseUrl}/`);
    assert.notEqual(root.status, 200);
  });
});

// ====================================================== the trust boundary

test('with no proxy configured, a forwarding header cannot choose a bucket', async () => {
  // THE DEFAULT, AND THE ONE THAT MATTERS MOST.
  //
  // `X-Forwarded-For` is a header; anyone can send one. With `trust proxy` at 0
  // Express ignores it entirely, so rotating it must not buy a fresh rate-limit
  // bucket. If it did, the login limiter would be decorative: an attacker would
  // simply change a header between attempts.
  await withServer({ trustProxy: 0 }, async (baseUrl) => {
    assert.equal(await login(baseUrl, '10.0.0.1'), 401, 'the first attempt should be allowed through to auth');
    assert.equal(await login(baseUrl, '10.0.0.2'), 429, 'a spoofed header bought a fresh login budget');
    assert.equal(await login(baseUrl, '203.0.113.99'), 429);
    // Removing the header entirely is the same bucket too — it was never read.
    assert.equal(await login(baseUrl), 429);
  });
});

test('with one proxy configured, the address the proxy appended is the one used', async () => {
  // A genuine proxy appends the connecting address to the RIGHT of whatever the
  // client sent. Trusting exactly one hop therefore reads past everything the
  // client wrote and lands on the proxy's own observation.
  //
  // Here the client claims to be 9.9.9.9 and the proxy appends the real 10.0.0.1.
  await withServer({ trustProxy: 1 }, async (baseUrl) => {
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.1'), 401);

    // Same real client, a different lie in front of it: still the same bucket,
    // because the lie is to the left of the trusted hop and is never read.
    assert.equal(await login(baseUrl, '1.2.3.4, 10.0.0.1'), 429, 'a spoofed prefix escaped the one-hop boundary');
    assert.equal(await login(baseUrl, '10.0.0.1'), 429);
  });
});

test('with one proxy configured, two real clients get separate buckets', async () => {
  // The other half of the same property, and the reason `trust proxy` has to be
  // set at all: distinct clients must not share a budget.
  await withServer({ trustProxy: 1 }, async (baseUrl) => {
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.1'), 401);
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.2'), 401, 'a second real client inherited the first one\'s budget');
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.1'), 429, 'the first client should now be out of budget');
  });
});

test('NEGATIVE CONTROL — behind a proxy without the setting, every client collapses into one bucket', async () => {
  // This is the failure the setting exists to prevent, reproduced deliberately.
  //
  // The app is behind a proxy (every request arrives with a forwarding chain)
  // but has not been told, so `req.ip` is the proxy's address for everyone.
  // Because `keyFor` keys authenticated callers by session, the endpoint that
  // suffers is the one with no session yet — sign-in. One stranger exhausts the
  // login budget for every user of the deployment.
  //
  // If this test ever passes with `trustProxy: 0` reporting separate buckets,
  // the assertions above have stopped meaning anything.
  await withServer({ trustProxy: 0 }, async (baseUrl) => {
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.1'), 401);
    assert.equal(
      await login(baseUrl, '9.9.9.9, 10.0.0.2'),
      429,
      'expected the collapse this setting exists to prevent; if these are separate buckets the control is broken',
    );
  });

  // And the same two clients ARE separated once the hop count is correct.
  await withServer({ trustProxy: 1 }, async (baseUrl) => {
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.1'), 401);
    assert.equal(await login(baseUrl, '9.9.9.9, 10.0.0.2'), 401);
  });
});

test('the trust setting defaults to zero and rejects nonsense', () => {
  assert.equal(loadConfig({}).config.trustProxy, 0, 'the default trusts a proxy nobody has configured');
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).config.trustProxy, 1);
  // Zero must be settable explicitly without being treated as an error — the
  // reason it does not go through `readInt`, which rejects anything <= 0.
  const explicitZero = loadConfig({ TRUST_PROXY: '0' });
  assert.equal(explicitZero.config.trustProxy, 0);
  assert.deepEqual(
    explicitZero.problems.filter((problem) => problem.includes('TRUST_PROXY')),
    [],
    'an explicit 0 was reported as a configuration problem',
  );

  for (const bad of ['-1', 'yes', '1.5']) {
    const result = loadConfig({ TRUST_PROXY: bad });
    assert.equal(result.config.trustProxy, 0, `TRUST_PROXY=${bad} was accepted`);
    assert.ok(result.problems.some((problem) => problem.includes('TRUST_PROXY')), `TRUST_PROXY=${bad} passed silently`);
  }
});

test('the front-end directory is configurable and defaults beside the server', () => {
  const { config } = loadConfig({});
  assert.match(config.webDistDir.replace(/\\/g, '/'), /web\/dist$/);
  assert.equal(loadConfig({ WEB_DIST_DIR: '/srv/app' }).config.webDistDir, '/srv/app');
});

// ================================================ nothing else moved (M7-A)

test('the deployment change did not loosen any cookie or CORS default', () => {
  const { config } = loadConfig({});

  // Secure cookies stay on by default and the allow-list stays empty: the whole
  // point of one origin is that neither has to be relaxed.
  assert.equal(config.cookieSecure, true);
  assert.deepEqual(config.corsAllowedOrigins, []);
});

test('outbound sending is still off by default', () => {
  const { config } = loadConfig({});
  assert.equal(config.allowOutboundSend, false);
  assert.equal(config.outboundProvider, 'none');
});
