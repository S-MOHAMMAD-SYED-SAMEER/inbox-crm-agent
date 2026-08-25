import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { createSequentialIds } from '../src/lib/ids.ts';
import { executePlan } from '../src/agent/execute/executor.ts';
import { planFingerprint } from '../src/domain/execution.ts';
import {
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { Database, SqlParam } from '../src/db/types.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// EXECUTOR TRANSACTION BINDING (FR-28).
//
// "Apply a multi-action plan atomically — all actions or none" is a claim about
// two database drivers, and it used to be true of only one of them.
//
// The executor opened `repos.db.transaction(...)` and then applied every action
// through the *outer* repositories. Repositories close over the handle they were
// built with, so those writes went out on the root handle rather than on the
// transaction. On SQLite the root handle IS the transaction's connection, so it
// worked by coincidence. On Postgres the root handle is a different pooled
// client: the writes would commit independently, and a mid-plan failure would
// roll back an empty transaction while leaving half a plan applied.
//
// HOW THE SECOND TEST BELOW CATCHES THAT WITHOUT A POSTGRES SERVER
//
// It gives the executor a database whose *root* handle refuses CRM inserts while
// transactions work normally — which is precisely the shape of the Postgres
// behaviour, expressed on SQLite. Applying a plan through transaction-bound
// repositories succeeds; applying it through root-bound ones fails loudly. Run
// against the old executor, it fails. That is the whole point of it.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-06-01T02:00:00.000Z', 1000);

const CRM_INSERTS = /INSERT INTO (companies|contacts|deals|tasks|activities|notes)\b/i;

function deps(repos: Repositories) {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider,
    logger: quiet,
    clock,
  };
}

type Counts = Record<'companies' | 'contacts' | 'deals' | 'tasks' | 'activities' | 'notes', number>;

async function countAll(repos: Repositories): Promise<Counts> {
  return {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
    notes: await repos.notes.count(),
  };
}

/** An approved, ready-to-run multi-action plan that touches five repositories. */
async function approvedPlan(): Promise<{
  db: Database;
  repos: Repositories;
  email: EmailRecord;
  decision: DecisionRecord;
  close(): Promise<void>;
}> {
  const ctx = await createTestContext({ idPrefix: 'tx' });
  await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));
  await ctx.repos.settings.set('autonomy_level', 'manual', 'test');

  const d = deps(ctx.repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});

  const emails = await ctx.repos.emails.list({ limit: 50 });
  const email = emails.find((row) => row.providerMessageId === 'demo-e01');
  assert.ok(email);

  const decision = await ctx.repos.decisions.getCurrentForEmail(email.id);
  assert.ok(decision);

  // create_company, create_contact, log_activity, create_deal, create_task,
  // send_email — five repositories in one plan, which is what makes a partial
  // application visible.
  assert.ok(decision.plan.actions.length >= 5);

  await ctx.repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  return { db: ctx.db, repos: ctx.repos, email, decision, close: ctx.close };
}

/** A database that fails one statement, propagating the fault into nested transactions. */
function failingOn(inner: Database, pattern: RegExp): Database {
  const wrap = (target: Database): Database => ({
    driver: target.driver,
    query: (sql, params) => target.query(sql, params as readonly SqlParam[] | undefined),
    exec: (sql) => target.exec(sql),
    execute: (sql, params) => {
      if (pattern.test(sql)) return Promise.reject(new Error('injected failure'));
      return target.execute(sql, params as readonly SqlParam[] | undefined);
    },
    transaction: (fn) => target.transaction((tx) => fn(wrap(tx))),
    close: () => target.close(),
  });
  return wrap(inner);
}

/**
 * A database whose ROOT handle refuses the given statements, while transactions
 * hand out an unrestricted handle.
 *
 * This is the Postgres pooling behaviour, modelled on SQLite: a write issued on
 * the root handle does not belong to the open transaction. Here it fails loudly
 * instead of silently committing, so the test can see it.
 */
function rootWritesForbidden(inner: Database, pattern: RegExp): Database {
  return {
    driver: inner.driver,
    query: (sql, params) => inner.query(sql, params as readonly SqlParam[] | undefined),
    exec: (sql) => inner.exec(sql),
    execute: (sql, params) => {
      if (pattern.test(sql)) {
        return Promise.reject(
          new Error(`a CRM write escaped the transaction and went out on the root handle: ${sql.slice(0, 60)}`),
        );
      }
      return inner.execute(sql, params as readonly SqlParam[] | undefined);
    },
    // The transaction hands back the real handle, unrestricted — so anything
    // bound to it can write freely.
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
  };
}

test('a mid-plan failure rolls back every repository the plan had already written to', async () => {
  const f = await approvedPlan();
  const before = await countAll(f.repos);

  // create_task is the fifth action: by the time it runs, a company, a contact,
  // an activity and a deal have all been written inside the transaction.
  const faulty = createRepositories(failingOn(f.db, /INSERT INTO tasks\b/i), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('faulty'),
  });

  const outcome = await executePlan(f.email, f.decision, { repos: faulty, clock, logger: quiet });

  assert.equal(outcome.ok, false);
  assert.match(outcome.refusalMessage ?? '', /injected failure/);

  // Not "the tasks table is unchanged" — every table is unchanged. A rollback
  // that only covered the repository that threw would leave an orphan company,
  // contact, activity and deal behind, which is the exact failure FR-28 exists
  // to prevent.
  assert.deepEqual(await countAll(f.repos), before);

  // The evidence of the failure survives the rollback, because it is written
  // afterwards in its own transaction.
  const executions = await f.repos.executions.listForDecision(f.decision.id);
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.status, 'failed');
  assert.equal(executions[0]?.actionType, 'create_task');

  const email = await f.repos.emails.getById(f.email.id);
  assert.equal(email?.state, 'execution_failed');
  assert.equal(email?.reviewReason, 'execution_failed');

  assert.equal(outcome.outbox, null, 'a reply was queued for a plan that never applied');

  await f.close();
});

test('the executor applies actions through transaction-bound repositories, not the root handle', async () => {
  // The regression test for the binding itself. Against the previous executor —
  // `repos.db.transaction(...)` with the outer repositories — every CRM insert
  // goes out on the root handle and this fails.
  const f = await approvedPlan();
  const before = await countAll(f.repos);

  const guarded = createRepositories(rootWritesForbidden(f.db, CRM_INSERTS), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('guarded'),
  });

  const outcome = await executePlan(f.email, f.decision, { repos: guarded, clock, logger: quiet });

  assert.equal(
    outcome.ok,
    true,
    `the plan did not apply through the transaction: ${outcome.refusalMessage ?? 'no reason given'}`,
  );

  const after = await countAll(f.repos);
  assert.equal(after.companies, before.companies + 1);
  assert.equal(after.contacts, before.contacts + 1);
  assert.equal(after.deals, before.deals + 1);
  assert.equal(after.tasks, before.tasks + 1);
  assert.equal(after.activities, before.activities + 1);

  await f.close();
});

test('the successful path still commits every action together', async () => {
  // The other half of "all actions or none": unchanged behaviour on success.
  const f = await approvedPlan();
  const before = await countAll(f.repos);

  const outcome = await executePlan(f.email, f.decision, { repos: f.repos, clock, logger: quiet });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.executions.filter((execution) => execution.status === 'succeeded').length, 6);

  const after = await countAll(f.repos);
  assert.equal(after.companies, before.companies + 1);
  assert.equal(after.contacts, before.contacts + 1);
  assert.equal(after.deals, before.deals + 1);
  assert.equal(after.tasks, before.tasks + 1);
  assert.equal(after.activities, before.activities + 1);

  const email = await f.repos.emails.getById(f.email.id);
  assert.equal(email?.state, 'completed');

  // The reply reached the outbox and was suppressed there, exactly as before.
  assert.equal(outcome.outbox?.status, 'suppressed');

  await f.close();
});

test('a rolled-back plan can be retried and then applies in full', async () => {
  // Atomicity is only useful if the failure is recoverable: the rollback must
  // leave the plan in a state a retry can complete, not a half-written one a
  // retry would duplicate.
  const f = await approvedPlan();
  const before = await countAll(f.repos);

  const faulty = createRepositories(failingOn(f.db, /INSERT INTO tasks\b/i), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('faulty'),
  });
  const failed = await executePlan(f.email, f.decision, { repos: faulty, clock, logger: quiet });
  assert.equal(failed.ok, false);
  assert.deepEqual(await countAll(f.repos), before);

  const retried = await executePlan(
    (await f.repos.emails.getById(f.email.id)) as EmailRecord,
    f.decision,
    { repos: f.repos, clock, logger: quiet },
  );

  assert.equal(retried.ok, true, retried.refusalMessage ?? '');

  const after = await countAll(f.repos);
  assert.equal(after.companies, before.companies + 1, 'the retry duplicated a company');
  assert.equal(after.contacts, before.contacts + 1, 'the retry duplicated a contact');
  assert.equal(after.deals, before.deals + 1);
  assert.equal(after.tasks, before.tasks + 1);

  await f.close();
});
