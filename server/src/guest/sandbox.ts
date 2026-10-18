import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { createTestDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';
import { createRepositories, type Repositories } from '../db/repositories/index.ts';
import { readSeedFile, seedDemoData } from '../db/seed.ts';
import type { Database } from '../db/types.ts';
import { createDemoEmailSource } from '../adapters/email/demo.ts';
import { createDisabledOutboundSender } from '../adapters/outbound/index.ts';
import { createEmailRouter } from '../routes/emails.ts';
import { createCrmRouter } from '../routes/crm.ts';
import { AppError } from '../lib/errors.ts';
import { createLogger, type Logger } from '../lib/logger.ts';
import type { Clock } from '../lib/clock.ts';
import { createRecordedProvider, type RecordedProvider, type Recording } from './recording.ts';

// One guest's private copy of the demo.
//
// WHAT A SANDBOX IS
//
// A brand-new in-memory SQLite database, migrated and seeded with the demo CRM and nothing else, plus its own recorded-answer
// provider, its own copy of the demo email source, and its own routes built over exactly those. A guest's request is handed to
// that router and to nothing else, so the code that serves a guest never holds the owner's database, another guest's database or
// a real model provider. Isolation is by construction: there is no query in which a guest id could be forgotten, because there is no
// shared table.
//
// WHAT A SANDBOX CANNOT DO
//
//   * Send mail. Its sender is the disabled sender, passed in explicitly, whatever the server's own configuration says.
//   * Call a model. Its provider is the recording.
//   * Outlive the process. It lives in memory; a crash or a restart leaves nothing behind to clean up.
//
// Everything the guest can reach is the email router and the CRM router. Anything else is refused (see `handle`).

export type SandboxState = {
  db: Database;
  repos: Repositories;
  provider: RecordedProvider;
  router: Router;
};

export type SandboxBuildDeps = {
  migrationsDir: string;
  demoDataDir: string;
  recording: Recording;
  clock: Clock;
  logger?: Logger;
};

/** A fresh, seeded, private copy of the demo state. The 10 demo emails are not ingested yet: they start at "Received" once ingested. */
export async function buildSandboxState(deps: SandboxBuildDeps): Promise<SandboxState> {
  const logger = deps.logger ?? createLogger('guest', { level: 'error' });
  const db = createTestDatabase();
  try {
    await runMigrations(db, deps.migrationsDir, { now: () => deps.clock.nowIso() });
    const repos = createRepositories(db, { clock: deps.clock });
    // Seeded at `manual`, like the owner's demo: nothing runs unattended.
    await seedDemoData(repos, readSeedFile(deps.demoDataDir), { autonomyLevel: 'manual' });

    const provider = createRecordedProvider(deps.recording);
    const source = createDemoEmailSource({ filePath: path.join(deps.demoDataDir, 'emails.json') });
    // Sending is off for a guest even if the server has it on: the sender is the refusing one, supplied here rather than read from
    // configuration.
    const sender = createDisabledOutboundSender('outbound_send_disabled');

    const router = Router();
    router.use(createEmailRouter({ repos, source, provider, logger, sender }));
    router.use(createCrmRouter(repos));
    return { db, repos, provider, router };
  } catch (err) {
    await db.close();
    throw err;
  }
}

export type Sandbox = {
  /** Public, random, never sent to the browser as an identifier it could present: the browser holds the token, the registry holds its hash. */
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfToken: string;
  readonly createdAt: string;
  readonly ip: string;
  lastSeenAt: string;
  resets: number;
  readonly repos: Repositories;
  readonly provider: RecordedProvider;
  /** Hands a request to this sandbox's own routes. Anything they do not handle is refused, never passed on to the owner's routes. */
  handle(req: Request, res: Response, next: NextFunction): void;
  /** Replaces the state with a fresh seeded copy: "Start over". */
  reset(): Promise<void>;
  /** Releases the database. */
  dispose(): Promise<void>;
};

export async function createSandbox(
  deps: SandboxBuildDeps,
  identity: { id: string; tokenHash: string; csrfToken: string; ip: string },
): Promise<Sandbox> {
  let state = await buildSandboxState(deps);
  const now = deps.clock.nowIso();

  const sandbox: Sandbox = {
    id: identity.id,
    tokenHash: identity.tokenHash,
    csrfToken: identity.csrfToken,
    createdAt: now,
    ip: identity.ip,
    lastSeenAt: now,
    resets: 0,
    get repos() {
      return state.repos;
    },
    get provider() {
      return state.provider;
    },
    handle(req, res, next) {
      state.router(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        // The sandbox's routes did not handle this. A guest never falls through to the owner's routes: default deny.
        next(new AppError('FORBIDDEN', 'This is not available in the guest demo.', { details: { reason: 'guest_demo' } }));
      });
    },
    async reset() {
      const next = await buildSandboxState(deps);
      const previous = state;
      state = next;
      sandbox.resets += 1;
      await previous.db.close();
    },
    async dispose() {
      await state.db.close();
    },
  };
  return sandbox;
}
