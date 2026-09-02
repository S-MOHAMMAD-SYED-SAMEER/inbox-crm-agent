import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { executePlan } from '../src/agent/execute/executor.ts';
import { sweepExpiredApprovals, isOverdue } from '../src/agent/approve/expiry.ts';
import { planFingerprint } from '../src/domain/execution.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import {
  handleApprove,
  handleDecidePending,
  handleExpireApprovals,
  handleListApprovals,
  handleReject,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M4-B tests: the approval queue and the expiry sweep.
//
// The governing rule throughout is spec §16's: **timeouts must never resolve in
// the direction of acting.** An unanswered approval becomes a question for a
// person, never a tacit yes and never a silent discard.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-06-01T02:00:00.000Z', 1000);

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

/** Runs the pipeline to the point where approvals exist. */
async function pipelineToApprovals(repos: Repositories): Promise<void> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  await repos.settings.set('autonomy_level', 'manual', 'test');
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});
}

/** Backdates an approval's window so it is past due. */
async function backdate(repos: Repositories, decisionId: string): Promise<void> {
  await repos.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
    '2020-01-01T00:00:00.000Z',
    decisionId,
  ]);
}

async function decisionFor(repos: Repositories, providerMessageId: string) {
  const email = await repos.emails.findByProviderMessageId('demo', providerMessageId);
  assert.ok(email, `fixture ${providerMessageId} missing`);
  const decision = await repos.decisions.getCurrentForEmail(email.id);
  assert.ok(decision, 'no decision');
  return { email, decision };
}

// ================================================================= 1-4. queue

test('1. a pending approval appears in the queue with its full context', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const queue = await handleListApprovals(deps(repos), { state: 'pending' });
  const row = queue.body.approvals.find((entry) => entry.email.subject.includes('Shopify'));
  assert.ok(row);

  assert.equal(row.approval.state, 'pending');
  assert.equal(row.email.fromEmail, 'sarah@acmecommerce.invalid');
  assert.equal(row.email.fromName, 'Sarah Williams');
  assert.equal(row.riskTier, 2);
  assert.equal(row.confidence, 0.91);
  assert.equal(row.confidenceBand, 'high');
  assert.ok(row.recommendation.length > 40, 'the one-line recommendation is readable');
  assert.ok(row.decision.plan.actions.length > 0);
  assert.ok(row.msToExpiry > 0);
  assert.ok(row.ageMs >= 0);
  assert.equal(row.actionable, true);
  assert.equal(row.hasDraft, true);
  assert.equal(row.draftBlocked, false);
  await close();
});

test('3+4. the queue carries the approval reasons and the draft for review', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const queue = await handleListApprovals(deps(repos), { state: 'pending' });
  const row = queue.body.approvals.find((entry) => entry.email.subject.includes('Shopify'));
  assert.ok(row);

  assert.ok(row.decision.plan.approvalReasons.length > 0, 'the reviewer is told why this needs them');
  for (const reason of row.decision.plan.approvalReasons) {
    assert.ok(reason.message.length > 20);
  }
  assert.ok(row.decision.plan.draft?.body.length);
  assert.ok(row.decision.plan.ruleTrace.length > 0, 'the trace is available for the diff view');
  await close();
});

test('2. the queue is ordered by SLA remaining, soonest first', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  // Three different windows, written out of order.
  const first = await decisionFor(repos, 'demo-e01');
  const second = await decisionFor(repos, 'demo-e02');
  const third = await decisionFor(repos, 'demo-e03');

  await repos.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', ['2026-06-05T00:00:00.000Z', second.decision.id]);
  await repos.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', ['2026-06-03T00:00:00.000Z', first.decision.id]);
  await repos.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', ['2026-06-04T00:00:00.000Z', third.decision.id]);

  const queue = await handleListApprovals(deps(repos), { state: 'pending' });
  const positions = queue.body.approvals.map((row) => row.approval.decisionId);

  assert.ok(
    positions.indexOf(first.decision.id) < positions.indexOf(third.decision.id),
    'the one expiring soonest comes first',
  );
  assert.ok(positions.indexOf(third.decision.id) < positions.indexOf(second.decision.id));

  // And the ordering is monotonic overall.
  const remaining = queue.body.approvals.map((row) => row.msToExpiry);
  for (let i = 1; i < remaining.length; i++) {
    assert.ok((remaining[i] as number) >= (remaining[i - 1] as number), 'SLA order must be monotonic');
  }
  await close();
});

test('the queue order is stable across identical reads', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const first = await handleListApprovals(deps(repos), { state: 'pending' });
  const second = await handleListApprovals(deps(repos), { state: 'pending' });
  assert.deepEqual(
    second.body.approvals.map((row) => row.approval.id),
    first.body.approvals.map((row) => row.approval.id),
    'a queue that reshuffles between reads looks broken even when it is right',
  );
  await close();
});

// ============================================================== 5-8. expiry

test('5+6. an overdue pending approval expires and the email goes to human review', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { email, decision } = await decisionFor(repos, 'demo-e01');
  await backdate(repos, decision.id);

  const result = await sweepExpiredApprovals({ repos, clock, logger: quiet });

  assert.equal(result.expired.length, 1);
  assert.equal(result.skipped, 0);

  const approval = await repos.approvals.getForDecision(decision.id);
  assert.equal(approval?.state, 'expired');
  assert.equal(approval?.decidedBy, 'system');

  const after = (await repos.emails.getById(email.id)) as EmailRecord;
  assert.equal(after.state, 'needs_review', 'towards a person, never towards an action');
  assert.equal(after.reviewReason, 'approval_expired');
  await close();
});

test('an approval still inside its window is untouched', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const result = await sweepExpiredApprovals({ repos, clock, logger: quiet });
  assert.equal(result.expired.length, 0);

  const { decision } = await decisionFor(repos, 'demo-e01');
  assert.equal((await repos.approvals.getForDecision(decision.id))?.state, 'pending');
  await close();
});

test('8. repeated sweeps are a no-op', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { decision } = await decisionFor(repos, 'demo-e01');
  await backdate(repos, decision.id);

  const first = await sweepExpiredApprovals({ repos, clock, logger: quiet });
  const second = await sweepExpiredApprovals({ repos, clock, logger: quiet });
  const third = await sweepExpiredApprovals({ repos, clock, logger: quiet });

  assert.equal(first.expired.length, 1);
  assert.equal(second.expired.length, 0);
  assert.equal(third.expired.length, 0);
  await close();
});

test('the sweep leaves an overdue approval alone when its email has moved on', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { email, decision } = await decisionFor(repos, 'demo-e01');
  await backdate(repos, decision.id);

  // Something else already handled it. Dragging it back to review would undo
  // whatever that was.
  await repos.emails.setState(email.id, 'completed');

  const result = await sweepExpiredApprovals({ repos, clock, logger: quiet });
  assert.equal(result.expired.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(((await repos.emails.getById(email.id)) as EmailRecord).state, 'completed');
  await close();
});

test('7+13. expiry writes exactly one audit event, however many times it is swept', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { email, decision } = await decisionFor(repos, 'demo-e01');
  await backdate(repos, decision.id);

  await sweepExpiredApprovals({ repos, clock, logger: quiet });
  await sweepExpiredApprovals({ repos, clock, logger: quiet });
  await sweepExpiredApprovals({ repos, clock, logger: quiet });

  const events = (await repos.audit.listByEmail(email.id)).filter((e) => e.eventType === 'approval_expired');
  assert.equal(events.length, 1, 'no duplicate expiry events');
  assert.equal(events[0]?.actor, 'system');
  assert.equal(events[0]?.outcome, 'blocked');
  assert.ok((events[0]?.summary ?? '').includes('Nothing was run'));

  // History is never rewritten.
  for (const method of ['update', 'delete', 'remove']) {
    assert.equal((repos.audit as unknown as Record<string, unknown>)[method], undefined);
  }
  await close();
});

test('isOverdue is true for a past-due pending approval before the sweep runs', () => {
  const now = '2026-06-01T02:00:00.000Z';
  assert.equal(isOverdue({ state: 'pending', expiresAt: '2026-06-01T01:00:00.000Z' }, now), true);
  assert.equal(isOverdue({ state: 'pending', expiresAt: '2026-06-02T00:00:00.000Z' }, now), false);
  assert.equal(isOverdue({ state: 'expired', expiresAt: '2099-01-01T00:00:00.000Z' }, now), true);
  assert.equal(isOverdue({ state: 'approved', expiresAt: '2020-01-01T00:00:00.000Z' }, now), false);
});

// ============================================================ 9-10. security

test('9. an expired approval cannot execute', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { email, decision } = await decisionFor(repos, 'demo-e01');
  const before = {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
  };

  await backdate(repos, decision.id);
  await sweepExpiredApprovals({ repos, clock, logger: quiet });

  // Force the email back into an executable state so the approval check — not
  // the state guard — is what has to refuse.
  await repos.emails.setState(email.id, 'awaiting_approval');
  const outcome = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_not_granted');
  assert.match(outcome.refusalMessage ?? '', /expired/);
  assert.equal(await repos.companies.count(), before.companies, 'nothing was written');
  assert.equal(await repos.contacts.count(), before.contacts);
  assert.equal(await repos.deals.count(), before.deals);
  await close();
});

test('an approval that is past due but not yet swept still cannot execute', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { email, decision } = await decisionFor(repos, 'demo-e01');

  // Approved, then the window closes before anyone runs it. The sweep has not
  // run, so the row still says `approved` — the executor checks the clock too.
  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });
  await backdate(repos, decision.id);

  const outcome = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_expired');
  await close();
});

test('10. an expired approval cannot be approved', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { decision } = await decisionFor(repos, 'demo-e01');

  await backdate(repos, decision.id);
  await sweepExpiredApprovals({ repos, clock, logger: quiet });

  const err = await rejects(() => handleApprove(deps(repos), decision.id, 'sameer'));
  assert.equal((err as { code?: string }).code, 'CONFLICT');
  assert.match(err.message, /already expired/);
  await close();
});

test('an expired approval cannot be rejected either — it is settled', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { decision } = await decisionFor(repos, 'demo-e01');

  await backdate(repos, decision.id);
  await sweepExpiredApprovals({ repos, clock, logger: quiet });

  const err = await rejects(() => handleReject(deps(repos), decision.id, { reason: 'too late' }, 'sameer'));
  assert.equal((err as { code?: string }).code, 'CONFLICT');
  await close();
});

test('expiry never produces an executable plan', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  // Expire everything, then confirm nothing became actionable anywhere.
  await repos.db.execute("UPDATE approvals SET expires_at = ? WHERE state = 'pending'", ['2020-01-01T00:00:00.000Z']);
  await sweepExpiredApprovals({ repos, clock, logger: quiet, limit: 100 });

  const queue = await handleListApprovals(deps(repos), { state: 'expired' });
  assert.ok(queue.body.approvals.length > 0);
  for (const row of queue.body.approvals) {
    assert.equal(row.actionable, false, 'an expired approval is never actionable');
    assert.equal(row.approval.state, 'expired');
    assert.equal(row.email.state, 'needs_review');
  }

  assert.equal(await repos.executions.count(), 0, 'expiry executed nothing');
  assert.equal(await repos.outbox.count(), 0, 'and queued nothing');
  await close();
});

// ============================================================== 11-12. API

test('11. the expire endpoint reports what it did and is safe to call twice', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const { decision } = await decisionFor(repos, 'demo-e01');
  await backdate(repos, decision.id);
  const d = deps(repos);

  const first = await handleExpireApprovals(d);
  assert.equal(first.body.expired, 1);
  assert.equal(first.body.emails.length, 1);

  const second = await handleExpireApprovals(d);
  assert.equal(second.body.expired, 0);
  await close();
});

test('12. the queue filters by state and reports counts for each', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const d = deps(repos);

  const e01 = await decisionFor(repos, 'demo-e01');
  const e02 = await decisionFor(repos, 'demo-e02');

  await handleApprove(d, e01.decision.id, 'sameer');
  await handleReject(d, e02.decision.id, { reason: 'Not for us.' }, 'sameer');

  const e03 = await decisionFor(repos, 'demo-e03');
  await backdate(repos, e03.decision.id);
  await handleExpireApprovals(d);

  const pending = await handleListApprovals(d, { state: 'pending' });
  const approved = await handleListApprovals(d, { state: 'approved' });
  const rejected = await handleListApprovals(d, { state: 'rejected' });
  const expired = await handleListApprovals(d, { state: 'expired' });

  assert.ok(approved.body.approvals.every((row) => row.approval.state === 'approved'));
  assert.equal(approved.body.approvals.length, 1);
  assert.equal(rejected.body.approvals.length, 1);
  assert.equal(expired.body.approvals.length, 1);
  assert.ok(pending.body.approvals.every((row) => row.approval.state === 'pending'));

  // The counts agree with the filtered lists.
  assert.equal(approved.body.counts.approved, 1);
  assert.equal(approved.body.counts.rejected, 1);
  assert.equal(approved.body.counts.expired, 1);
  assert.equal(pending.body.counts.pending, pending.body.approvals.length);
  await close();
});

test('an unknown state filter is rejected rather than silently ignored', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleListApprovals(deps(repos), { state: 'whenever' }));
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  await close();
});

test('a settled row shows who decided it and why', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);
  const d = deps(repos);
  const { decision } = await decisionFor(repos, 'demo-e02');

  await handleReject(d, decision.id, { reason: 'Out of scope for us.' }, 'sameer');

  const rejected = await handleListApprovals(d, { state: 'rejected' });
  const row = rejected.body.approvals[0];
  assert.equal(row?.approval.decidedBy, 'sameer');
  assert.equal(row?.approval.reason, 'Out of scope for us.');
  assert.ok(row?.approval.decidedAt);
  assert.equal(row?.actionable, false);
  await close();
});

test('the queue exposes no secrets and no raw email body', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToApprovals(repos);

  const queue = await handleListApprovals(deps(repos), { state: 'pending' });
  const serialised = JSON.stringify(queue.body);

  assert.doesNotMatch(serialised, /We run a small Shopify store/, 'the body stays on the email, not in the queue');
  assert.doesNotMatch(serialised, /sk-ant|password|api[_-]?key/i);
  await close();
});
