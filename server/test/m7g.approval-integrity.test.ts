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
import {
  handleApprove,
  handleDecidePending,
  handleListApprovals,
  handleListEmails,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// The two production faults found on the real Approvals screen.
//
// The symptom was "I approve several pending items and only one works". The
// backend turned out to be sound — approving five in a row succeeded every
// time. What was wrong was the DATA: emails carried two and three decisions
// each, and approvals belonging to superseded decisions sat at `pending`
// forever. Some of their emails had already `completed`, so the executor
// refused them and the row simply never cleared.
//
// Two causes, fixed at both ends:
//
//   1. A re-decide superseded the DECISION and orphaned its APPROVAL. Only the
//      revise path ever settled one.
//   2. Nothing stopped two overlapping DECIDE batches selecting the same rows,
//      so each wrote its own decision.
//
// TWO LIMITS OF THE CONCURRENCY TESTS BELOW, STATED RATHER THAN IMPLIED
//
// They run against one in-memory SQLite connection, where interleaved
// transactions share a savepoint namespace and collide ("no such savepoint").
// Production uses a PostgreSQL pool, where each transaction holds its own
// client. So these assert that the compare-and-swap admits one writer; they are
// not a faithful model of concurrent transactions.
//
// And the guard cannot cover an unattended tier-0 plan. `nextState` leaves such
// a plan in `deciding` on purpose, so the swap has no state change to race on
// and a second batch can still write a decision. The residue is extra rows in
// decision history: no approval is requested for an unattended plan, and a
// second execution is refused once the email reaches a terminal state. Closing
// it would need a new claim state (a migration) or an executor that accepts
// `executing` (a change to the safety model), and both were out of scope.

const quiet = createLogger('m7g', { level: 'error' });

// `createTestContext` pins the repositories to a fixed clock. The approval
// handlers default to `systemClock`, so a test that does not match it finds
// every approval months past its SLA and refused as expired — which looks
// exactly like the bug under investigation. Matching it is not a workaround;
// it is the difference between testing the code and testing the calendar.
const clock = createFixedClock('2026-06-01T00:00:00.000Z', 1000);

function deps(repos: Repositories) {
  const mock = createMockLlmProvider();
  registerDemoFixtures(mock, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider: mock,
    logger: quiet,
    clock,
  };
}

/** Seeds and runs the pipeline as far as DECIDE, leaving pending approvals. */
async function pipelineToApprovals(repos: Repositories): Promise<void> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});
}

// =================================== approving several, one after another

test('several independent pending approvals can all be approved in turn', async () => {
  // The user-facing claim, asserted end to end. This passed before the fix too
  // — which is exactly why the bug was in the data rather than the flow, and
  // why the two tests below are the ones that matter.
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const queue = await handleListApprovals({ repos, clock }, { state: 'pending' });
  assert.ok(queue.body.approvals.length >= 3, `PRECONDITION: need several pending, got ${queue.body.approvals.length}`);

  let approved = 0;
  for (const row of queue.body.approvals) {
    // Deliberately using the rows fetched BEFORE any approval, which is what
    // the screen holds while an operator works down the list.
    const result = await handleApprove(deps(repos), row.decision.id, 'sameer');
    if (result.body.ok) approved += 1;
  }

  assert.equal(approved, queue.body.approvals.length, 'not every independent approval succeeded');

  const after = await handleListApprovals({ repos, clock }, { state: 'pending' });
  assert.equal(after.body.approvals.length, 0, 'approvals were left pending after being approved');

  await close();
});

// ============================ a re-decide must not orphan its approval

test('re-deciding an email leaves no pending approval for the superseded decision', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const emails = await handleListEmails({ repos }, { state: 'awaiting_approval' });
  const target = emails.body.emails[0];
  assert.ok(target, 'PRECONDITION: an email awaiting approval is required');

  const first = await repos.decisions.getCurrentForEmail(target.id);
  assert.ok(first);
  assert.equal((await repos.approvals.getForDecision(first.id))?.state, 'pending');

  // Decide it again — the plain agent path, not a revision.
  const email = await repos.emails.getById(target.id);
  assert.ok(email);
  const { decideEmail } = await import('../src/agent/decide/decide.ts');
  const outcome = await decideEmail(email, deps(repos));

  assert.ok(outcome.decision, 'the re-decide produced no decision');
  assert.notEqual(outcome.decision.id, first.id, 'the re-decide reused the previous decision');

  // The old decision is superseded...
  assert.ok((await repos.decisions.getById(first.id))?.supersededBy, 'the old decision was not superseded');

  // ...and so is its approval. This is the fix: it used to stay `pending`.
  const orphan = await repos.approvals.getForDecision(first.id);
  assert.equal(orphan?.state, 'superseded', 'the superseded decision kept an actionable pending approval');

  // Which means the queue shows exactly one pending row for this email, not two.
  const pending = await handleListApprovals({ repos, clock }, { state: 'pending' });
  const forEmail = pending.body.approvals.filter((row) => row.email.id === target.id);
  assert.equal(forEmail.length, 1, `the queue shows ${forEmail.length} pending approvals for one email`);
  assert.equal(forEmail[0]?.decision.id, outcome.decision.id, 'the pending row is not the current decision');

  await close();
});

test('a superseded approval can never be approved', async () => {
  // The safety consequence of the fix: a plan that is no longer current is
  // unapprovable, rather than merely invisible.
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const emails = await handleListEmails({ repos }, { state: 'awaiting_approval' });
  const target = emails.body.emails[0];
  assert.ok(target);
  const first = await repos.decisions.getCurrentForEmail(target.id);
  assert.ok(first);

  const email = await repos.emails.getById(target.id);
  assert.ok(email);
  const { decideEmail } = await import('../src/agent/decide/decide.ts');
  await decideEmail(email, deps(repos));

  // Refusal may arrive either as a declined result or as a conflict error —
  // both are refusals. What must never happen is execution.
  let executed = true;
  try {
    const result = await handleApprove(deps(repos), first.id, 'sameer');
    executed = result.body.ok;
  } catch {
    executed = false;
  }
  assert.equal(executed, false, 'a superseded plan was executed');

  await close();
});

// ============================ concurrent DECIDE must not duplicate

test('concurrent decide batches never leave an email with two pending approvals', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});

  const waiting = await repos.emails.list({ state: 'deciding', limit: 100 });
  assert.ok(waiting.length > 0, 'PRECONDITION: emails must be waiting to be decided');

  // Three batches at once — what an operator produces by clicking a slow button
  // repeatedly, and exactly how production ended up with three decisions on one
  // email and approvals nobody could action.
  await Promise.all([
    handleDecidePending(deps(repos), {}),
    handleDecidePending(deps(repos), {}),
    handleDecidePending(deps(repos), {}),
  ]);

  const pending = await handleListApprovals({ repos, clock }, { state: 'pending' });
  const perEmail = new Map<string, number>();
  for (const row of pending.body.approvals) {
    perEmail.set(row.email.id, (perEmail.get(row.email.id) ?? 0) + 1);
  }
  const duplicated = [...perEmail.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [], 'an email carries more than one pending approval');

  // And every pending row belongs to its email's CURRENT decision, so nothing
  // in the queue is already superseded.
  for (const row of pending.body.approvals) {
    const current = await repos.decisions.getCurrentForEmail(row.email.id);
    assert.equal(row.decision.id, current?.id, `${row.email.subject} shows a superseded decision as pending`);
  }

  await close();
});

test('concurrent batches produce one decision for every plan that needs approval', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});

  await Promise.all([handleDecidePending(deps(repos), {}), handleDecidePending(deps(repos), {})]);

  const emails = await repos.emails.list({ state: 'awaiting_approval', limit: 100 });
  assert.ok(emails.length > 0, 'PRECONDITION: some plans must require approval');

  for (const email of emails) {
    const all = await repos.decisions.listForEmail(email.id);
    assert.equal(all.length, 1, `${email.subject} ended with ${all.length} decisions after concurrent batches`);
  }

  await close();
});
