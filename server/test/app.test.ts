import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { MIGRATION_COUNT, createTestContext, startAuthenticatedServer } from './helpers.ts';

// HTTP wiring tests.
//
// The handlers are tested directly elsewhere — that is the point of the
// `{ status, body }` shape. What can only be tested through a real server is
// the wiring itself: the JSON parse error handler, the 404 shape, and the fact
// that the terminal error handler emits an envelope rather than Express's
// default HTML page. Node's built-in fetch and an ephemeral port cover it with
// no HTTP-testing dependency (NFR-9).

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const ctx = await createTestContext();
  const { logger } = createMemoryLogger('http');
  const app = createApp({ db: ctx.db, logger });
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

test('GET /api/health answers with the health payload', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal((body.database as Record<string, unknown>).migrationsApplied, MIGRATION_COUNT);
  });
});

test('an unknown API route returns the standard error envelope', async () => {
  // CONTRACT CHANGE (M5-A): the authentication gate sits above the catch-all, so
  // an unauthenticated caller gets 401 for every path — including paths that do
  // not exist. That is the desired order: which routes exist is not something an
  // unauthenticated stranger should be able to enumerate.
  await withServer(async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/does-not-exist`);
    const anonymousBody = (await anonymous.json()) as { error: { code: string } };
    assert.equal(anonymous.status, 401);
    assert.equal(anonymousBody.error.code, 'UNAUTHORIZED');
  });

  const { db, close } = await createTestContext();
  const server = await startAuthenticatedServer(db);
  try {
    const response = await fetch(`${server.url}/api/does-not-exist`, { headers: { cookie: server.cookie } });
    const body = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 404, 'an authenticated caller should learn the route does not exist');
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.message.length > 0);
  } finally {
    await server.stop();
    await close();
  }
});

test('malformed JSON returns a clean 400, not an HTML stack trace', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ "broken": ',
    });

    const text = await response.text();
    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /<html|<pre|at Object|\\\\|\/src\//i, 'a stack trace must never reach a client');

    const body = JSON.parse(text) as { error: { code: string } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });
});

test('an oversized body is rejected rather than buffered', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
    });

    assert.equal(response.status, 413);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });
});

test('the server does not advertise what it is built with', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});
