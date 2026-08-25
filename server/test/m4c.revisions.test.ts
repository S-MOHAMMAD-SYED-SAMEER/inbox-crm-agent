import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR, MIGRATION_COUNT } from './helpers.ts';
import { appliedMigrations } from '../src/db/migrate.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { verifyExecutable } from '../src/agent/execute/executor.ts';
import { createLogger } from '../src/lib/logger.ts';
import { APPROVAL_STATES } from '../src/domain/execution.ts';
import { DECISION_ORIGINS } from '../src/domain/decision.ts';
import {
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';

// M4-C.1 — the revision foundation.
//
// This milestone builds no revision *logic*: no edit envelope, no endpoint, no
// UI. What it builds is the ability for the database and the repositories to
// represent a revision honestly, and these tests lock the three properties that
// make that representation worth anything:
//
//   1. A revision is a NEW row. The decision it revises is byte-identical
//      afterwards, because the original AI proposal paired with the human's
//      version is the whole point (FR-26).
//   2. Provenance cannot be incoherent. An edit without a parent or an editor,
//      or an agent decision carrying either, is refused at the only place that
//      writes decisions.
//   3. `superseded` is terminal. An approval that has been superseded can no
//      more become approved than a rejected one can — and the guard proving
//      that is the same one that already protected the other three states.

const quiet = createLogger('test', { level: 'error' });

function deps(repos: Repositories) {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider,
    logger: quiet,
  };
}

/** One real decision, produced by the real pipeline, to build revisions from. */
async function firstDecision(repos: Repositories): Promise<DecisionRecord> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  await repos.settings.set('autonomy_level', 'manual', 'test');

  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});

  const decisions = await repos.decisions.listAwaitingApproval(50);
  const decision = decisions[0];
  assert.ok(decision, 'the pipeline produced no decision to revise');
  return decision;
}

/** The revision provenance a human edit must carry. */
function asEdit(parent: DecisionRecord, editedBy = 'sameer') {
  return {
    emailId: parent.emailId,
    analysisId: parent.analysisId,
    resolutionRun: parent.resolutionRun,
    plan: parent.plan,
    model: parent.model,
    promptVersion: parent.promptVersion,
    latencyMs: parent.latencyMs,
    origin: 'human_edit' as const,
    parentDecisionId: parent.id,
    editedBy,
  };
}

// --- the migration ----------------------------------------------------------

test('migration 008 applies cleanly with every other migration', async () => {
  const { db, close } = await createTestContext();

  const applied = await appliedMigrations(db);
  assert.equal(applied.length, MIGRATION_COUNT);
  assert.ok(
    applied.some((migration) => migration.name === '008_revisions.sql'),
    'migration 008 did not run',
  );

  await close();
});

test('the rebuilt approvals table keeps its key, its uniqueness and its foreign key', async () => {
  // The rebuild is the only non-additive migration in the project. A copy that
  // dropped a constraint would leave every existing safety test passing while
  // the database quietly stopped enforcing the thing they rely on.
  const { db, repos, close } = await createTestContext();
  const decision = await firstDecision(repos);

  await repos.approvals.request(decision.id, 24);

  // UNIQUE(decision_id): one approval per decision, so an approval can never
  // straddle two versions of a plan.
  const duplicate = await rejects(() =>
    db.execute(
      'INSERT INTO approvals (id, decision_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ['dupe', decision.id, 'pending', '2026-07-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    ),
  );
  assert.match(duplicate.message, /unique|constraint/i);

  // REFERENCES decisions(id): an approval for a plan that does not exist.
  const orphan = await rejects(() =>
    db.execute(
      'INSERT INTO approvals (id, decision_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ['orphan', 'no-such-decision', 'pending', '2026-07-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    ),
  );
  assert.match(orphan.message, /foreign key|constraint/i);

  await close();
});

// --- decision revision fields ----------------------------------------------

test('an agent decision defaults to revision 1, origin agent, no parent and no editor', async () => {
  const { repos, close } = await createTestContext();
  const decision = await firstDecision(repos);

  assert.equal(decision.revision, 1);
  assert.equal(decision.origin, 'agent');
  assert.equal(decision.parentDecisionId, null);
  assert.equal(decision.editedBy, null);

  await close();
});

test('revision fields round-trip through the database', async () => {
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const created = await repos.decisions.create(asEdit(parent, 'sameer'));
  const reloaded = await repos.decisions.getById(created.id);

  assert.ok(reloaded);
  assert.equal(reloaded.revision, 2);
  assert.equal(reloaded.origin, 'human_edit');
  assert.equal(reloaded.parentDecisionId, parent.id);
  assert.equal(reloaded.editedBy, 'sameer');
  assert.deepEqual(reloaded.plan.actions, parent.plan.actions);

  await close();
});

test('revision numbers increment across the whole history of one email', async () => {
  const { repos, close } = await createTestContext();
  const first = await firstDecision(repos);

  const second = await repos.decisions.create(asEdit(first));
  const third = await repos.decisions.create(asEdit(second));

  assert.deepEqual([first.revision, second.revision, third.revision], [1, 2, 3]);

  await close();
});

test('creating a revision leaves the decision it revises byte-identical', async () => {
  // The property the entire milestone exists for: the AI proposal survives the
  // edit. Everything except `superseded_by` — which is history, not content —
  // must be exactly as it was.
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const revision = await repos.decisions.create(asEdit(parent));
  const parentAfter = await repos.decisions.getById(parent.id);

  assert.ok(parentAfter);
  assert.deepEqual({ ...parentAfter, supersededBy: null }, parent);
  assert.equal(parentAfter.supersededBy, revision.id);
  assert.equal(revision.supersededBy, null);

  await close();
});

test('the parent link survives further revisions', async () => {
  const { repos, close } = await createTestContext();
  const first = await firstDecision(repos);

  const second = await repos.decisions.create(asEdit(first));
  await repos.decisions.create(asEdit(second));

  const secondAfter = await repos.decisions.getById(second.id);
  assert.equal(secondAfter?.parentDecisionId, first.id, 'the backward link was lost when v3 arrived');

  await close();
});

// --- provenance validation --------------------------------------------------

test('a human edit must name the decision it was edited from', async () => {
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const err = await rejects(() =>
    repos.decisions.create({ ...asEdit(parent), parentDecisionId: null }),
  );
  assert.match(err.message, /edited from/i);

  await close();
});

test('a human edit must record who made it', async () => {
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const err = await rejects(() => repos.decisions.create({ ...asEdit(parent), editedBy: null }));
  assert.match(err.message, /who made it/i);

  await close();
});

test('an agent decision cannot carry a parent or an editor', async () => {
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const withParent = await rejects(() =>
    repos.decisions.create({ ...asEdit(parent), origin: 'agent', editedBy: null }),
  );
  assert.match(withParent.message, /no parent and no editor/i);

  const withEditor = await rejects(() =>
    repos.decisions.create({ ...asEdit(parent), origin: 'agent', parentDecisionId: null }),
  );
  assert.match(withEditor.message, /no parent and no editor/i);

  await close();
});

test('a revision cannot claim a parent that does not exist', async () => {
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const err = await rejects(() =>
    repos.decisions.create({ ...asEdit(parent), parentDecisionId: 'no-such-decision' }),
  );
  assert.match(err.message, /parent decision/i);

  await close();
});

test('a revision cannot adopt a parent belonging to a different email', async () => {
  // Without this, a revision could attach itself to another email's decision
  // chain — and the audit trail would say a human edited a plan they never saw.
  const { repos, close } = await createTestContext();
  const parent = await firstDecision(repos);

  const others = (await repos.decisions.listAwaitingApproval(50)).filter(
    (decision) => decision.emailId !== parent.emailId,
  );
  const other = others[0];
  assert.ok(other, 'the demo set produced only one decision, so this case cannot be tested');

  const err = await rejects(() =>
    repos.decisions.create({ ...asEdit(parent), emailId: other.emailId }),
  );
  assert.match(err.message, /same email/i);

  await close();
});

test('the database rejects an origin outside the domain union', async () => {
  // The CHECK constraint, not the TypeScript type, is what a hand-written UPDATE
  // or a future migration would meet.
  const { db, repos, close } = await createTestContext();
  const decision = await firstDecision(repos);

  const err = await rejects(() =>
    db.execute('UPDATE decisions SET origin = ? WHERE id = ?', ['nonsense', decision.id]),
  );
  assert.match(err.message, /constraint/i);

  for (const origin of DECISION_ORIGINS) {
    await db.execute('UPDATE decisions SET origin = ? WHERE id = ?', [origin, decision.id]);
  }

  await close();
});

// --- the superseded approval state -----------------------------------------

test('superseded is a recognised approval state', async () => {
  assert.ok(APPROVAL_STATES.includes('superseded'));
});

test('a pending approval can be superseded, and says who did it and why', async () => {
  const { repos, close } = await createTestContext();
  const decision = await firstDecision(repos);
  await repos.approvals.request(decision.id, 24);

  const superseded = await repos.approvals.decide(decision.id, 'superseded', {
    decidedBy: 'system',
    reason: 'Replaced by a human-edited revision.',
  });

  assert.equal(superseded.state, 'superseded');
  assert.equal(superseded.decidedBy, 'system');
  assert.match(superseded.reason ?? '', /revision/i);
  assert.ok(superseded.decidedAt);

  const listed = await repos.approvals.listByState('superseded');
  assert.deepEqual(listed.map((approval) => approval.id), [superseded.id]);

  await close();
});

test('a superseded approval cannot be moved to any other state', async () => {
  const { repos, close } = await createTestContext();
  const decision = await firstDecision(repos);
  await repos.approvals.request(decision.id, 24);
  await repos.approvals.decide(decision.id, 'superseded', { decidedBy: 'system' });

  for (const next of ['approved', 'rejected', 'expired'] as const) {
    const err = await rejects(() =>
      repos.approvals.decide(decision.id, next, { decidedBy: 'attacker' }),
    );
    assert.match(err.message, /already superseded/i, `superseded → ${next} was not refused`);
  }

  assert.equal((await repos.approvals.getForDecision(decision.id))?.state, 'superseded');

  await close();
});

test('an already-settled approval cannot be superseded', async () => {
  // The terminal guard has to run in both directions, or an approved plan could
  // be quietly retired by creating a revision after the fact.
  for (const settled of ['approved', 'rejected', 'expired'] as const) {
    const ctx = await createTestContext({ idPrefix: settled });
    const decision = await firstDecision(ctx.repos);
    await ctx.repos.approvals.request(decision.id, 24);
    await ctx.repos.approvals.decide(decision.id, settled, { decidedBy: 'operator', reason: 'r' });

    const err = await rejects(() =>
      ctx.repos.approvals.decide(decision.id, 'superseded', { decidedBy: 'system' }),
    );
    assert.match(err.message, new RegExp(`already ${settled}`, 'i'));

    await ctx.close();
  }
});

test('a superseded approval authorises nothing', async () => {
  // Widening the state enum is only safe because the executor asks whether the
  // approval is `approved`, not whether it is settled. This locks that: adding
  // a fifth state must not have created a fifth way to be authorised.
  const { repos, close } = await createTestContext();
  const decision = await firstDecision(repos);
  await repos.approvals.request(decision.id, 24);
  await repos.approvals.decide(decision.id, 'superseded', { decidedBy: 'system' });

  const email = await repos.emails.getById(decision.emailId);
  assert.ok(email);
  assert.equal(email.state, 'awaiting_approval');

  const refusal = await verifyExecutable(email, decision, repos, '2026-06-01T02:00:00.000Z');
  assert.equal(refusal?.code, 'approval_not_granted');

  await close();
});

test('a superseded approval is never swept as expired', async () => {
  // M4-B's sweep reads `state = 'pending'`. If a superseded approval could still
  // be found by it, the sweep would drag the email to needs_review while it was
  // legitimately awaiting approval on the revision.
  const { db, repos, close } = await createTestContext();
  const decision = await firstDecision(repos);
  await repos.approvals.request(decision.id, 24);
  await repos.approvals.decide(decision.id, 'superseded', { decidedBy: 'system' });

  await db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
    '2020-01-01T00:00:00.000Z',
    decision.id,
  ]);

  const overdue = await repos.approvals.listExpired('2026-06-02T00:00:00.000Z', 100);
  assert.deepEqual(overdue, []);

  await close();
});
