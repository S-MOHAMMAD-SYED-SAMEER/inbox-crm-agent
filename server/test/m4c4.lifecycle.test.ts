import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { createSequentialIds } from '../src/lib/ids.ts';
import { reviseDecision } from '../src/agent/revise/revise.ts';
import { sweepExpiredApprovals } from '../src/agent/approve/expiry.ts';
import { executePlan, verifyExecutable } from '../src/agent/execute/executor.ts';
import {
  handleApprove,
  handleDecidePending,
  handleGetEmail,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { Database, SqlParam } from '../src/db/types.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M4-C.4 — the whole human-in-the-loop lifecycle, end to end.
//
// The earlier milestones each proved their own piece. This file proves they
// compose: an email arrives, the assistant proposes, a person rewrites the
// reply, the rewritten plan goes back into the queue, a person approves *that*,
// and only then does anything reach the CRM — with nothing sent, nothing
// duplicated, and the original proposal still on the record.
//
// It deliberately runs on `demo-e01`, the hero lead: tier 2, a drafted reply, a
// send_email action and five CRM writes. The cheaper demo emails would prove
// the mechanics while skipping every part that actually carries risk.

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

type Fixture = {
  db: Database;
  repos: Repositories;
  email: EmailRecord;
  decision: DecisionRecord;
  taskIndex: number;
  close(): Promise<void>;
};

/** Steps 1–5: ingest → understand → resolve → decide → pending approval. */
async function pipeline(providerMessageId = 'demo-e01', autonomy = 'manual'): Promise<Fixture> {
  const ctx = await createTestContext({ idPrefix: providerMessageId });
  await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));
  await ctx.repos.settings.set('autonomy_level', autonomy as 'manual', 'test');

  const d = deps(ctx.repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});

  const emails = await ctx.repos.emails.list({ limit: 50 });
  const email = emails.find((row) => row.providerMessageId === providerMessageId);
  assert.ok(email, `no email ${providerMessageId}`);

  const decision = await ctx.repos.decisions.getCurrentForEmail(email.id);
  assert.ok(decision, `no decision for ${providerMessageId}`);

  return {
    db: ctx.db,
    repos: ctx.repos,
    email,
    decision,
    taskIndex: decision.plan.actions.findIndex((action) => action.type === 'create_task'),
    close: ctx.close,
  };
}

const revise = (repos: Repositories, decisionId: string, edits: unknown, editedBy = 'sameer') =>
  reviseDecision(decisionId, { edits, editedBy }, { repos, clock, logger: quiet });

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

// ---------------------------------------------------------------------------
// §1, §6  the whole lifecycle
// ---------------------------------------------------------------------------

test('the full lifecycle: propose, revise, approve the revision, apply it, send nothing', async () => {
  const f = await pipeline();
  const before = await countAll(f.repos);

  // 5. The assistant's proposal is waiting for a person.
  assert.equal(f.decision.revision, 1);
  assert.equal(f.decision.origin, 'agent');
  assert.equal(f.decision.plan.requiresApproval, true);
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');
  assert.equal((await f.repos.emails.getById(f.email.id))?.state, 'awaiting_approval');

  // 6. A person rewrites the reply and renames the follow-up.
  const result = await revise(f.repos, f.decision.id, {
    draft: {
      subject: 'Thanks for getting in touch',
      body: 'Hi Sarah,\n\nThanks for reaching out. When would suit you for a short call this week?\n\nSameer',
    },
    actions: [{ index: f.taskIndex, field: 'title', value: 'Call Sarah about cart recovery' }],
  });

  // 7, 8, 9.
  assert.equal(result.revision, 2);
  assert.equal(result.decision.origin, 'human_edit');
  assert.equal(result.decision.parentDecisionId, f.decision.id);
  assert.equal(result.supersededApproval.state, 'superseded');
  assert.equal(result.approval.state, 'pending');

  // Still nothing has happened. Editing is not approving.
  assert.deepEqual(await countAll(f.repos), before);
  assert.equal((await f.repos.executions.listForDecision(result.decision.id)).length, 0);
  assert.equal(await f.repos.outbox.count(), 0);

  // 10, 11. Approve the revision through the ordinary endpoint.
  const approved = await handleApprove(deps(f.repos), result.decision.id, 'sameer');
  assert.equal(approved.body.ok, true, approved.body.refusalMessage ?? '');
  assert.equal(approved.body.executed, 6);

  // 12. The CRM changed exactly once, for the revised plan.
  const after = await countAll(f.repos);
  assert.equal(after.companies, before.companies + 1);
  assert.equal(after.contacts, before.contacts + 1);
  assert.equal(after.deals, before.deals + 1);
  assert.equal(after.tasks, before.tasks + 1);
  assert.equal(after.activities, before.activities + 1);

  // The human's wording is what landed, not the model's.
  const tasks = await f.repos.tasks.list({ limit: 50 });
  assert.ok(
    tasks.some((task) => task.title === 'Call Sarah about cart recovery'),
    'the CRM recorded the assistant\'s title rather than the human\'s',
  );

  // Execution records carry the evidence a later undo would need.
  const executions = await f.repos.executions.listForDecision(result.decision.id);
  assert.equal(executions.length, 6);
  for (const execution of executions) {
    assert.equal(execution.status, 'succeeded');
    assert.ok(execution.idempotencyKey.length > 0);
    if (execution.actionType.startsWith('create_')) {
      assert.equal(execution.beforeSnapshot, null, `${execution.actionType} claimed a prior state`);
      assert.ok(execution.afterSnapshot, `${execution.actionType} recorded no result`);
      assert.ok(execution.targetId, `${execution.actionType} recorded no target`);
    }
  }

  // v1 executed nothing at all.
  assert.deepEqual(await f.repos.executions.listForDecision(f.decision.id), []);

  // 13. The reply reached the outbox and stopped there.
  const outbox = await f.repos.outbox.findForDecision(result.decision.id);
  assert.ok(outbox);
  assert.equal(outbox.status, 'suppressed');
  assert.equal(outbox.suppressedReason, 'outbound_send_disabled');
  assert.equal(outbox.subject, 'Thanks for getting in touch');
  assert.match(outbox.body, /When would suit you/);
  assert.equal((await f.repos.outbox.listByStatus('sent')).length, 0);

  // 14. The audit tells the whole story, in order.
  const events = await f.repos.audit.listByEmail(f.email.id);
  const types: string[] = events.map((event) => event.eventType);
  for (const expected of [
    'email_received',
    'plan_created',
    'plan_revised',
    'approval_superseded',
    'approval_granted',
    'action_executed',
    'outbox_suppressed',
  ]) {
    assert.ok(types.includes(expected), `the audit trail is missing ${expected}`);
  }
  assert.ok(
    types.indexOf('plan_revised') < types.indexOf('approval_granted'),
    'the approval was recorded before the revision it approved',
  );

  const detail = await handleGetEmail(deps(f.repos), f.email.id);
  assert.equal(detail.body.email.state, 'completed');
  assert.deepEqual(
    detail.body.revisions.map((entry) => [entry.revision, entry.approvalState]),
    [
      [1, 'superseded'],
      [2, 'approved'],
    ],
  );

  await f.close();
});

// ---------------------------------------------------------------------------
// §7  idempotency of a revised plan
// ---------------------------------------------------------------------------

test('re-running an approved revision changes nothing the second or third time', async () => {
  const f = await pipeline();
  const before = await countAll(f.repos);

  const result = await revise(f.repos, f.decision.id, {
    actions: [{ index: f.taskIndex, field: 'priority', value: 'medium' }],
  });
  await handleApprove(deps(f.repos), result.decision.id, 'sameer');

  const afterFirst = await countAll(f.repos);
  const executionsAfterFirst = (await f.repos.executions.listForDecision(result.decision.id)).length;

  for (const attempt of [2, 3]) {
    // Force the email back to an executable state so the idempotency guard —
    // not the state machine — is what has to stop the second write.
    await f.repos.emails.setState(f.email.id, 'awaiting_approval');
    const repeat = await executePlan(
      (await f.repos.emails.getById(f.email.id)) as EmailRecord,
      result.decision,
      { repos: f.repos, clock, logger: quiet },
    );

    assert.equal(repeat.ok, true, `run ${attempt} refused: ${repeat.refusalMessage ?? ''}`);
    assert.deepEqual(await countAll(f.repos), afterFirst, `run ${attempt} duplicated CRM rows`);
    assert.equal(
      (await f.repos.executions.listForDecision(result.decision.id)).length,
      executionsAfterFirst,
      `run ${attempt} duplicated execution records`,
    );
  }

  // And exactly one outbox entry, still suppressed.
  assert.equal(await f.repos.outbox.count(), 1);
  assert.equal((await f.repos.outbox.listByStatus('sent')).length, 0);
  assert.equal(afterFirst.companies, before.companies + 1);

  await f.close();
});

// ---------------------------------------------------------------------------
// §3  an unsafe human edit changes nothing
// ---------------------------------------------------------------------------

test('an unsafe human edit leaves the CRM, the outbox and the original plan untouched', async () => {
  const f = await pipeline();
  const before = await countAll(f.repos);

  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      draft: {
        body: 'Hi Sarah,\n\nWe can do this for $499 a month, guaranteed live within 2 weeks.\n\nSameer',
      },
    }),
  );
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');

  // No revision, no CRM change, nothing queued to send.
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);
  assert.deepEqual(await countAll(f.repos), before);
  assert.equal(await f.repos.outbox.count(), 0);
  assert.equal(await f.repos.executions.count(), 0);

  // v1 is still exactly where it was, and still editable.
  const v1 = await f.repos.decisions.getById(f.decision.id);
  assert.deepEqual(v1, f.decision);
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');

  // The attempt is on the record — without the words that caused it.
  const blocked = (await f.repos.audit.listByEmail(f.email.id)).find(
    (event) => event.eventType === 'draft_edit_blocked',
  );
  assert.ok(blocked, 'an unsafe edit was not audited');
  assert.equal(blocked.actor, 'human');
  assert.equal(blocked.outcome, 'blocked');

  const serialised = JSON.stringify(blocked);
  assert.ok(!serialised.includes('$499'), 'the audit event captured the offending text');
  assert.ok(!serialised.includes('2 weeks'), 'the audit event captured the offending text');
  assert.ok(!serialised.includes(f.email.bodyText.slice(0, 40)), 'the audit event captured the email body');

  await f.close();
});

// ---------------------------------------------------------------------------
// §5  atomicity, then a clean retry
// ---------------------------------------------------------------------------

test('a rolled-back revision leaves no trace, and the retry produces exactly one v2', async () => {
  const f = await pipeline();

  const faulty = createRepositories(failingOn(f.db, /INSERT INTO audit_events/i), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('faulty'),
  });

  const err = await rejects(() =>
    reviseDecision(
      f.decision.id,
      { edits: { actions: [{ index: f.taskIndex, field: 'title', value: 'Call Sarah' }] }, editedBy: 'sameer' },
      { repos: faulty, clock, logger: quiet },
    ),
  );
  assert.match(err.message, /injected failure/);

  // Exactly the state before the attempt.
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);
  assert.deepEqual(await f.repos.decisions.getById(f.decision.id), f.decision);
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');
  assert.equal(await f.repos.approvals.count(), 7);

  const retry = await revise(f.repos, f.decision.id, {
    actions: [{ index: f.taskIndex, field: 'title', value: 'Call Sarah' }],
  });

  // Exactly one v2, one new approval, one of each audit event.
  const history = await f.repos.decisions.listForEmail(f.email.id);
  assert.equal(history.length, 2);
  assert.equal(retry.revision, 2);
  assert.equal(await f.repos.approvals.count(), 8);
  assert.equal((await f.repos.approvals.getForDecision(retry.decision.id))?.state, 'pending');

  const events = await f.repos.audit.listByEmail(f.email.id);
  assert.equal(events.filter((event) => event.eventType === 'plan_revised').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'approval_superseded').length, 1);

  await f.close();
});

// ---------------------------------------------------------------------------
// §8  a revised approval can expire, and expiry grants nothing
// ---------------------------------------------------------------------------

test('a pending revision can expire, and expiry never creates authority', async () => {
  const f = await pipeline();
  const before = await countAll(f.repos);

  const result = await revise(f.repos, f.decision.id, {
    actions: [{ index: f.taskIndex, field: 'title', value: 'Call Sarah' }],
  });
  assert.equal(result.approval.state, 'pending');

  // Advance past the window.
  await f.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
    '2020-01-01T00:00:00.000Z',
    result.decision.id,
  ]);

  const swept = await sweepExpiredApprovals({ repos: f.repos, clock, logger: quiet, limit: 50 });
  assert.equal(swept.expired.length, 1);
  assert.equal(swept.expired[0]?.decisionId, result.decision.id);

  assert.equal((await f.repos.approvals.getForDecision(result.decision.id))?.state, 'expired');
  // The superseded v1 approval is untouched: it was already terminal.
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'superseded');

  const email = (await f.repos.emails.getById(f.email.id)) as EmailRecord;
  assert.equal(email.state, 'needs_review');
  assert.equal(email.reviewReason, 'approval_expired');

  const expiredEvents = (await f.repos.audit.listByEmail(f.email.id)).filter(
    (event) => event.eventType === 'approval_expired',
  );
  assert.equal(expiredEvents.length, 1);
  assert.equal(expiredEvents[0]?.actor, 'system');

  // The expired revision cannot run — the timeout resolved away from acting.
  await f.repos.emails.setState(f.email.id, 'awaiting_approval');
  const refusal = await verifyExecutable(
    (await f.repos.emails.getById(f.email.id)) as EmailRecord,
    result.decision,
    f.repos,
    clock.nowIso(),
  );
  assert.equal(refusal?.code, 'approval_not_granted');

  const outcome = await executePlan(
    (await f.repos.emails.getById(f.email.id)) as EmailRecord,
    result.decision,
    { repos: f.repos, clock, logger: quiet },
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(await countAll(f.repos), before);
  assert.equal(await f.repos.outbox.count(), 0);

  await f.close();
});

// ---------------------------------------------------------------------------
// §4  the approval floor, proved through execution
// ---------------------------------------------------------------------------

test('a settings change after v1 cannot make v2 executable without approval', async () => {
  const f = await pipeline('demo-e05', 'manual');
  const taskIndex = f.decision.plan.actions.findIndex((action) => action.type === 'create_task');
  assert.equal(f.decision.plan.riskTier, 0);
  assert.equal(f.decision.plan.requiresApproval, true);

  // The one route by which a recomputation could come back weaker.
  await f.repos.settings.set('autonomy_level', 'autonomous_low_risk', 'test');

  const result = await revise(f.repos, f.decision.id, {
    actions: [{ index: taskIndex, field: 'title', value: 'Call Priya back' }],
  });

  assert.equal(result.decision.plan.requiresApproval, true);
  assert.equal(result.decision.plan.riskTier, f.decision.plan.riskTier);
  assert.ok(
    result.decision.plan.approvalReasons.some((reason) => reason.code === 'inherited_from_original'),
    'the floor engaged without telling the operator why',
  );

  const before = await countAll(f.repos);
  const outcome = await executePlan(
    (await f.repos.emails.getById(f.email.id)) as EmailRecord,
    result.decision,
    { repos: f.repos, clock, logger: quiet },
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_not_granted');
  assert.deepEqual(await countAll(f.repos), before);

  // And with a real approval it runs, so the floor blocks the bypass rather
  // than the feature.
  const approved = await handleApprove(deps(f.repos), result.decision.id, 'sameer');
  assert.equal(approved.body.ok, true, approved.body.refusalMessage ?? '');

  await f.close();
});

test('a plan that needs no approval is not editable at all', async () => {
  // This is why the floor only ever has to defend one direction.
  //
  // An edit begins from the approval queue, and the admission rule (M4-C.2) is
  // "a pending approval and no executions". A plan that needs no approval has
  // no approval record, so it is never editable — which means a revision can
  // never START from an un-gated plan, and the `v1.requiresApproval ||
  // recomputed` floor can never be asked to turn false into true.
  //
  // Worth locking, because it is the reason the asymmetry is safe rather than
  // an oversight: the only direction reachable through the API is the one that
  // keeps a human involved.
  const f = await pipeline('demo-e05', 'autonomous_low_risk');
  const taskIndex = f.decision.plan.actions.findIndex((action) => action.type === 'create_task');

  assert.equal(f.decision.plan.requiresApproval, false, 'the fixture did not start un-gated');
  assert.equal(await f.repos.approvals.getForDecision(f.decision.id), null);

  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      actions: [{ index: taskIndex, field: 'title', value: 'Call Priya back' }],
    }),
  );

  assert.equal((err as { code?: string }).code, 'INVALID_STATE');

  // CONTRACT CHANGE (M6-E): the refusal reason moved from `approval_missing` to
  // `already_executed`. An un-gated plan now runs the moment it is decided, so
  // by the time anything can try to edit it, it has already run — which is a
  // stronger reason to refuse, not a weaker one. Both are accepted here because
  // the claim under test is that the edit is refused and no second decision is
  // created, not which of two correct refusals fires first.
  const refusedWith = (err as { details?: { refusedWith?: string } }).details?.refusedWith;
  assert.ok(
    refusedWith === 'already_executed' || refusedWith === 'approval_missing',
    `an un-gated plan was refused for an unexpected reason: ${refusedWith}`,
  );
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('the approval requirement of a revision is the stronger of the two, never the weaker', async () => {
  // The floor is a max, and both of its reachable inputs are exercised here:
  // the original said "a human is needed", and the recomputation is consulted
  // rather than assumed.
  const f = await pipeline('demo-e01', 'manual');

  const result = await revise(f.repos, f.decision.id, {
    actions: [{ index: f.taskIndex, field: 'priority', value: 'low' }],
  });

  // Tier 2 means the recomputation says "required" on its own merits, so the
  // floor and the recomputation agree and no inherited reason is needed.
  assert.equal(result.decision.plan.requiresApproval, true);
  assert.equal(result.decision.plan.riskTier, 2);
  assert.ok(
    result.decision.plan.approvalReasons.some((reason) => reason.code === 'consequential_action'),
    'the recomputation was not consulted',
  );
  assert.ok(
    !result.decision.plan.approvalReasons.some((reason) => reason.code === 'inherited_from_original'),
    'the floor claimed credit for a requirement the recomputation produced by itself',
  );

  await f.close();
});
