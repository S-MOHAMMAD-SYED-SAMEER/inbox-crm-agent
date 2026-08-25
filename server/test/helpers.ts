import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../src/db/index.ts';
import { runMigrations, readMigrations } from '../src/db/migrate.ts';
import { createRepositories, type Repositories } from '../src/db/repositories/index.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createSequentialIds } from '../src/lib/ids.ts';
import type { Database } from '../src/db/types.ts';

// Test harness.
//
// Every integration test gets a real schema — the actual migration files, run
// for real — in an in-memory database, with a fixed clock and sequential ids.
// Nothing is mocked, nothing is stubbed, and no file is written to disk, so the
// tests exercise the same repositories and the same SQL that production runs
// while staying deterministic and needing no credentials.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
export const DEMO_DATA_DIR = path.resolve(__dirname, '../data/demo');

/**
 * How many migrations exist, read from disk rather than hard-coded.
 *
 * M1 added a fourth migration and every test that had written `3` failed. The
 * assertion those tests wanted was "all of them were applied", not "there are
 * exactly three" — so the number is derived, and adding a fifth migration will
 * not break them again.
 */
export const MIGRATION_COUNT = readMigrations(MIGRATIONS_DIR).length;

export type TestContext = {
  db: Database;
  repos: Repositories;
  close(): Promise<void>;
};

export async function createTestContext(options: { idPrefix?: string } = {}): Promise<TestContext> {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR, { now: () => '2026-01-01T00:00:00.000Z' });

  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds(options.idPrefix ?? 'test'),
  });

  return {
    db,
    repos,
    close: () => db.close(),
  };
}

/** Asserts that a promise rejects, and returns the error for further assertions. */
export async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected the operation to reject, but it resolved.');
}

// --- authenticated HTTP (M5-A) ----------------------------------------------
//
// Every API endpoint except health and the auth routes now requires a session.
// Tests that exercise HTTP therefore have to sign in first, exactly as a browser
// does. This helper is the whole ceremony in one call so that a test about
// revisions stays a test about revisions.

/** A password used only by the test suite. Never a default anywhere in src. */
export const TEST_OPERATOR_PASSWORD = 'test-operator-password-1234';

export type AuthenticatedServer = {
  url: string;
  /** Cookie header carrying a live session. */
  cookie: string;
  /** The session's CSRF token, for M5-B. */
  csrf: string;
  stop(): Promise<void>;
};

/**
 * Starts the app with authentication configured, signs in, and returns the
 * cookie to use for subsequent requests.
 */
export async function startAuthenticatedServer(db: Database): Promise<AuthenticatedServer> {
  const { createApp } = await import('../src/app.ts');
  const { loadConfig } = await import('../src/config/env.ts');
  const { hashPassword } = await import('../src/lib/password.ts');
  const { createMemoryLogger } = await import('../src/lib/logger.ts');
  const { readCookie, SESSION_COOKIE, CSRF_COOKIE } = await import('../src/auth/cookies.ts');

  const config = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(TEST_OPERATOR_PASSWORD),
    cookieSecure: false,
  };

  const app = createApp({ db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;

  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TEST_OPERATOR_PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`test sign-in failed with ${response.status}`);

  const setCookie = response.headers.getSetCookie();
  const token = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
  const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';

  return {
    url,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    csrf: csrf ?? '',
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
