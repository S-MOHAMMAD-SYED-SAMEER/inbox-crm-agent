import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, startAuthenticatedServer, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { createSequentialIds } from '../src/lib/ids.ts';
import { reviseDecision } from '../src/agent/revise/revise.ts';
import { validateEditEnvelope } from '../src/agent/revise/editEnvelope.ts';
import { verifyExecutable, executePlan } from '../src/agent/execute/executor.ts';
import { planFingerprint, idempotencyKey } from '../src/domain/execution.ts';
import {
  handleApprove,
  handleRevise,
  handleDecidePending,
  handleGetEmail,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { Database, SqlParam } from '../src/db/types.ts';
import type { AutonomyLevel } from '../src/domain/policy.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M4-C.2 — the revision engine.
//
// One property sits underneath most of these tests: **a human edit produces a
// new plan and never mutates the old one**, and the authority to act does not
// travel with the edit. v2 leaves this engine with a *pending* approval, which
// means the edit itself grants nothing at all — the same approval endpoint and
// the same executor still stand between it and the CRM.
//
// The second property is that everything about risk is recomputed server-side.
// The request contributes edits and a name. It does not get a vote on whether
// the result is safe, and several tests below try to make it one.

const quiet = createLogger('test', { level: 'error' });

// The repositories in `createTestContext` stamp SLA windows from their own
// fixed clock (2026-06-01). The engine's clock runs slightly ahead of it, as
// wall-clock time would, so "in the future" means the same thing to both.
const clock = createFixedClock('2026-06-01T02:00:00.000Z', 1000);

const FUTURE = '2026-09-01T09:00:00.000Z';
const PAST = '2026-02-01T09:00:00.000Z';

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

type Fixture = {
  db: Database;
  repos: Repositories;
  decision: DecisionRecord;
  email: EmailRecord;
  /** Index of the create_task action, which carries editable fields. */
  taskIndex: number;
  close(): Promise<void>;
};

/**
 * A pending, editable plan.
 *
 * `demo-e01` is the hero lead: tier 2, a drafted reply, and a create_task —
 * every editable surface in one plan, and the highest-stakes one to get wrong.
 */
async function pending(
  providerMessageId = 'demo-e01',
  autonomy: AutonomyLevel = 'manual',
): Promise<Fixture> {
  const ctx = await createTestContext({ idPrefix: providerMessageId });
  await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));
  await ctx.repos.settings.set('autonomy_level', autonomy, 'test');

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
    decision,
    email,
    taskIndex: decision.plan.actions.findIndex((action) => action.type === 'create_task'),
    close: ctx.close,
  };
}

const revise = (repos: Repositories, decisionId: string, edits: unknown, editedBy = 'sameer') =>
  reviseDecision(decisionId, { edits, editedBy }, { repos, clock, logger: quiet });

/** The create_task payload of a fixture's plan. */
function taskPayload(f: Fixture): Record<string, unknown> {
  const action = f.decision.plan.actions[f.taskIndex];
  assert.ok(action, 'the fixture has no create_task action');
  return action.payload as Record<string, unknown>;
}

/** A minimal, always-valid edit. */
const renameTask = (index: number, title = 'Call Sarah about the chatbot') => ({
  actions: [{ index, field: 'title', value: title }],
});

// ---------------------------------------------------------------------------
// 1–9, 39–43, 47  the happy path and what it records
// ---------------------------------------------------------------------------

test('a valid draft edit creates v2 and leaves v1 byte-identical', async () => {
  const f = await pending();
  const v1 = f.decision;

  const result = await revise(f.repos, v1.id, {
    draft: { subject: 'Thanks for reaching out about your store' },
  });

  assert.equal(result.revision, 2);
  assert.equal(result.decision.origin, 'human_edit');
  assert.equal(result.decision.parentDecisionId, v1.id);
  assert.equal(result.decision.editedBy, 'sameer');
  assert.equal(result.decision.plan.draft?.subject, 'Thanks for reaching out about your store');

  const v1After = await f.repos.decisions.getById(v1.id);
  assert.ok(v1After);
  assert.deepEqual({ ...v1After, supersededBy: null }, v1);
  assert.equal(v1After.supersededBy, result.decision.id);

  await f.close();
});

test('v1 approval becomes superseded and v2 gets its own pending approval with a fresh SLA', async () => {
  const f = await pending();
  const before = await f.repos.approvals.getForDecision(f.decision.id);
  assert.equal(before?.state, 'pending');

  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  const v1Approval = await f.repos.approvals.getForDecision(f.decision.id);
  assert.equal(v1Approval?.state, 'superseded');
  assert.equal(v1Approval?.decidedBy, 'system');
  assert.match(v1Approval?.reason ?? '', /revision 2/i);

  assert.equal(result.approval.state, 'pending');
  assert.equal(result.approval.decisionId, result.decision.id);
  assert.ok(
    Date.parse(result.approval.expiresAt) > Date.parse(before?.expiresAt as string),
    'the revision did not get a fresh SLA window',
  );

  await f.close();
});

test('v2 has a different plan fingerprint from v1', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  assert.notEqual(planFingerprint(result.decision.plan), planFingerprint(f.decision.plan));

  await f.close();
});

test('the revision is recorded in the audit log, without any email content', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, {
    draft: { body: 'Hi Sarah,\n\nHappy to help. When would suit you for a quick call?\n\nSameer' },
  });

  const events = await f.repos.audit.listByEmail(f.email.id);

  const revised = events.find((event) => event.eventType === 'plan_revised');
  assert.ok(revised, 'no plan_revised event');
  assert.equal(revised.actor, 'human');
  assert.equal(revised.actorId, 'sameer');
  const payload = revised.payload as Record<string, unknown>;
  assert.equal(payload.fromDecisionId, f.decision.id);
  assert.equal(payload.toDecisionId, result.decision.id);
  assert.equal(payload.revision, 2);
  assert.deepEqual(payload.changedPaths, ['draft.body']);
  assert.ok(typeof payload.diffDigest === 'string' && payload.diffDigest.length > 0);

  const superseded = events.find((event) => event.eventType === 'approval_superseded');
  assert.ok(superseded, 'no approval_superseded event');
  assert.equal(superseded.actor, 'system');

  // §19: message content never reaches the audit log. The edited body quotes
  // the customer's own email, so a diff of *values* would leak it.
  const serialised = JSON.stringify([revised, superseded]);
  assert.ok(!serialised.includes('Happy to help'), 'the audit log captured the edited reply text');
  assert.ok(!serialised.includes(f.email.bodyText.slice(0, 40)), 'the audit log captured the email body');

  await f.close();
});

test('the edit diff reconstructs v1 into v2 exactly', async () => {
  const f = await pending();
  const v1 = f.decision;

  const result = await revise(f.repos, v1.id, {
    draft: { subject: 'A new subject line' },
    actions: [
      { index: f.taskIndex, field: 'title', value: 'Call Sarah' },
      { index: f.taskIndex, field: 'priority', value: 'low' },
      { index: f.taskIndex, field: 'dueAt', value: FUTURE },
    ],
  });

  assert.equal(result.diff.length, 4);

  // Replay the diff against v1 and the result must be v2.
  const replayed = structuredClone(v1.plan);
  for (const entry of result.diff) {
    if (entry.actionIndex === null) {
      assert.ok(replayed.draft);
      assert.equal((replayed.draft as Record<string, unknown>)[entry.field], entry.before);
      (replayed.draft as Record<string, unknown>)[entry.field] = entry.after;
    } else {
      const payload = replayed.actions[entry.actionIndex]?.payload as Record<string, unknown>;
      assert.equal(payload[entry.field] ?? null, entry.before);
      payload[entry.field] = entry.after;
    }
  }

  assert.deepEqual(replayed.actions, result.decision.plan.actions);
  assert.equal(replayed.draft?.subject, result.decision.plan.draft?.subject);

  await f.close();
});

test('the approval stores the final actions, the final draft and the diff', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, {
    draft: { subject: 'A new subject line' },
    actions: [{ index: f.taskIndex, field: 'title', value: 'Call Sarah' }],
  });

  const stored = await f.repos.approvals.getEdit(result.decision.id);
  assert.ok(stored, 'the approval recorded no edit');
  assert.deepEqual(stored.editedActions, result.decision.plan.actions);
  assert.deepEqual(stored.editedDraft, {
    subject: 'A new subject line',
    body: result.decision.plan.draft?.body,
  });
  assert.deepEqual(stored.editDiff, result.diff);

  // v1's approval keeps recording nothing: it was superseded, not edited.
  assert.equal(await f.repos.approvals.getEdit(f.decision.id), null);

  await f.close();
});

test('only fields that actually changed appear in the diff', async () => {
  const f = await pending();
  const currentTitle = taskPayload(f).title;

  const result = await revise(f.repos, f.decision.id, {
    actions: [
      { index: f.taskIndex, field: 'title', value: currentTitle },
      { index: f.taskIndex, field: 'priority', value: 'low' },
    ],
  });

  assert.deepEqual(
    result.diff.map((entry) => entry.field),
    ['priority'],
  );

  await f.close();
});

test('an edit that changes nothing is refused rather than creating an empty revision', async () => {
  // A no-op revision would still supersede the pending approval and restart the
  // SLA clock — real consequences for no change.
  const f = await pending();
  const currentTitle = taskPayload(f).title;

  const err = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ index: f.taskIndex, field: 'title', value: currentTitle }] }),
  );
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');

  await f.close();
});

test('revising is deterministic: the same edit on the same plan produces the same plan and diff', async () => {
  const a = await pending();
  const b = await pending();

  const edits = {
    draft: { subject: 'Same subject' },
    actions: [{ index: a.taskIndex, field: 'title', value: 'Same title' }],
  };

  const first = await revise(a.repos, a.decision.id, edits);
  const second = await revise(b.repos, b.decision.id, edits);

  // The fixtures' own `dueAt` comes from a ticking clock during DECIDE, so the
  // two starting plans already differ there. What must be identical is what the
  // revision engine itself produced: the same diff, the same edited values, and
  // the same recomputed policy.
  assert.deepEqual(first.diff, second.diff);
  assert.equal(first.decision.plan.draft?.subject, second.decision.plan.draft?.subject);
  assert.equal(first.decision.plan.requiresApproval, second.decision.plan.requiresApproval);
  assert.equal(first.decision.plan.riskTier, second.decision.plan.riskTier);
  assert.deepEqual(first.decision.plan.approvalReasons, second.decision.plan.approvalReasons);
  assert.deepEqual(
    first.decision.plan.actions.map((action) => (action.payload as { title?: string }).title),
    second.decision.plan.actions.map((action) => (action.payload as { title?: string }).title),
  );

  await a.close();
  await b.close();
});

// ---------------------------------------------------------------------------
// 10, 11, 38  authority does not travel with the edit
// ---------------------------------------------------------------------------

test('v1 approval cannot authorise v2', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  const email = (await f.repos.emails.getById(f.email.id)) as EmailRecord;
  assert.equal(email.state, 'awaiting_approval');

  // v2 is pending. Nothing about the revision authorised it.
  const refusal = await verifyExecutable(email, result.decision, f.repos, clock.nowIso());
  assert.equal(refusal?.code, 'approval_not_granted');

  const outcome = await executePlan(email, result.decision, { repos: f.repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.executions.length, 0);

  await f.close();
});

test('the superseded v1 plan cannot execute, even if its approval were granted', async () => {
  const f = await pending();
  await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  const email = (await f.repos.emails.getById(f.email.id)) as EmailRecord;
  const v1 = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;

  const refusal = await verifyExecutable(email, v1, f.repos, clock.nowIso());
  assert.equal(refusal?.code, 'decision_superseded');

  await f.close();
});

test('v2 executes only through the existing approval path, and its actions get fresh idempotency keys', async () => {
  const f = await pending('demo-e05');
  const taskIndex = f.decision.plan.actions.findIndex((action) => action.type === 'create_task');

  const result = await revise(f.repos, f.decision.id, renameTask(taskIndex, 'Reply to Priya about the outage'));

  const response = await handleApprove(deps(f.repos), result.decision.id, 'sameer');
  assert.equal(response.body.ok, true);
  assert.ok(response.body.executed > 0);

  const executions = await f.repos.executions.listForDecision(result.decision.id);
  assert.ok(executions.length > 0);

  // Keys are derived from the decision id (§15), so a revision's keys can never
  // collide with v1's. That is precisely why a plan which has already executed
  // may not be revised — the writes would not deduplicate, they would double.
  const keys = executions.map((execution) => execution.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const execution of executions) {
    assert.notEqual(
      execution.idempotencyKey,
      idempotencyKey(f.decision.id, execution.sequence, execution.actionType, null),
    );
  }

  // v1 executed nothing: the revision replaced it before anything ran.
  assert.deepEqual(await f.repos.executions.listForDecision(f.decision.id), []);

  await f.close();
});

// ---------------------------------------------------------------------------
// 12–17, 44  lifecycle eligibility
// ---------------------------------------------------------------------------

test('a plan that is not pending approval cannot be edited', async () => {
  for (const settled of ['approved', 'rejected', 'expired', 'superseded'] as const) {
    const f = await pending();
    await f.repos.approvals.decide(f.decision.id, settled, { decidedBy: 'operator', reason: 'r' });

    const err = await rejects(() => revise(f.repos, f.decision.id, renameTask(f.taskIndex)));
    assert.equal((err as { code?: string }).code, 'INVALID_STATE', `editing a ${settled} plan was allowed`);
    assert.equal((err as { details?: { refusedWith?: string } }).details?.refusedWith, 'approval_not_pending');

    // v1 is untouched and no v2 exists.
    assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

    await f.close();
  }
});

test('a superseded decision cannot be edited again', async () => {
  const f = await pending();
  await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  const err = await rejects(() => revise(f.repos, f.decision.id, renameTask(f.taskIndex, 'Third go')));
  assert.equal((err as { details?: { refusedWith?: string } }).details?.refusedWith, 'decision_superseded');

  await f.close();
});

test('a plan cannot be edited while it is executing', async () => {
  const f = await pending();
  await f.repos.emails.setState(f.email.id, 'executing');

  const err = await rejects(() => revise(f.repos, f.decision.id, renameTask(f.taskIndex)));
  assert.equal((err as { details?: { refusedWith?: string } }).details?.refusedWith, 'email_executing');
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('a plan that has already written to the CRM cannot be edited', async () => {
  // The sharpest hazard in the milestone: idempotency keys are derived from the
  // decision id, so a revision's actions would carry fresh keys and re-apply
  // every write that already succeeded.
  const f = await pending();
  await f.repos.executions.record({
    decisionId: f.decision.id,
    sequence: 0,
    actionType: 'log_activity',
    payload: {},
    status: 'succeeded',
    idempotencyKey: 'already-done',
  });

  const err = await rejects(() => revise(f.repos, f.decision.id, renameTask(f.taskIndex)));
  assert.equal((err as { details?: { refusedWith?: string } }).details?.refusedWith, 'already_executed');
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('a decision with no approval at all cannot be edited', async () => {
  const f = await pending('demo-e09', 'assisted');
  const err = await rejects(() => revise(f.repos, f.decision.id, { actions: [{ index: 0, field: 'reason', value: 'x' }] }));
  assert.equal((err as { code?: string }).code, 'INVALID_STATE');

  await f.close();
});

// ---------------------------------------------------------------------------
// 18–32, 46  the whitelist
// ---------------------------------------------------------------------------

test('an unknown field path is refused', async () => {
  const f = await pending();
  const err = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ index: f.taskIndex, field: 'nonsense', value: 'x' }] }),
  );
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify((err as { details?: unknown }).details), /not a field of that action/);

  await f.close();
});

test('an unknown key in the envelope itself is refused', async () => {
  const f = await pending();

  for (const envelope of [
    { plan: { riskTier: 0 } },
    { requiresApproval: false },
    { actions: [{ index: f.taskIndex, field: 'title', value: 'x', tier: 0 }] },
  ]) {
    const err = await rejects(() => revise(f.repos, f.decision.id, envelope));
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  }

  await f.close();
});

test('every immutable field is refused by name', async () => {
  const f = await pending();
  const plan = f.decision.plan;
  const at = (type: string) => plan.actions.findIndex((action) => action.type === type);

  const attempts: Array<{ label: string; index: number; field: string; value: unknown }> = [
    { label: 'action type', index: f.taskIndex, field: 'type', value: 'send_email' },
    { label: 'contact EntityRef', index: f.taskIndex, field: 'contact', value: { kind: 'existing', id: 'x' } },
    { label: 'company EntityRef', index: f.taskIndex, field: 'company', value: { kind: 'existing', id: 'x' } },
    { label: 'deal EntityRef', index: f.taskIndex, field: 'deal', value: { kind: 'existing', id: 'x' } },
    { label: 'contact email', index: at('create_contact'), field: 'email', value: 'attacker@evil.example' },
    { label: 'reply recipient', index: at('send_email'), field: 'toEmail', value: 'attacker@evil.example' },
    {
      label: 'in-reply-to',
      index: at('send_email'),
      field: 'inReplyToProviderMessageId',
      value: 'forged',
    },
    { label: 'deal stage', index: at('create_deal'), field: 'stage', value: 'won' },
    { label: 'deal title', index: at('create_deal'), field: 'title', value: 'Bigger deal' },
    { label: 'company name', index: at('create_company'), field: 'name', value: 'Other Co' },
  ];

  for (const attempt of attempts) {
    assert.ok(attempt.index >= 0, `the fixture has no action for "${attempt.label}"`);
    const err = await rejects(() =>
      revise(f.repos, f.decision.id, {
        actions: [{ index: attempt.index, field: attempt.field, value: attempt.value }],
      }),
    );
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR', `${attempt.label} was accepted`);
  }

  // Nothing was created by any of them.
  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');

  await f.close();
});

test('deal amount and deal stage changes are refused on the actions that carry them', async () => {
  const f = await pending('demo-e06');
  const stageIndex = f.decision.plan.actions.findIndex((action) => action.type === 'update_deal_stage');
  assert.ok(stageIndex >= 0);

  for (const field of ['toStage', 'fromStage', 'dealId']) {
    const err = await rejects(() =>
      revise(f.repos, f.decision.id, { actions: [{ index: stageIndex, field, value: 'won' }] }),
    );
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR', `${field} was accepted`);
  }

  await f.close();
});

test('actions cannot be added, removed or reordered', async () => {
  const f = await pending();
  const count = f.decision.plan.actions.length;

  // Adding: an index past the end.
  const added = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ index: count, field: 'title', value: 'x' }] }),
  );
  assert.match(JSON.stringify((added as { details?: unknown }).details), /out of range/);

  // Removing / replacing the set wholesale: the envelope has no vocabulary for it.
  const replaced = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ type: 'create_task', payload: {} }] }),
  );
  assert.equal((replaced as { code?: string }).code, 'VALIDATION_ERROR');

  // Reordering: likewise unsayable — edits address actions by index.
  const reordered = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ index: 1, from: 1, to: 0 }] }),
  );
  assert.equal((reordered as { code?: string }).code, 'VALIDATION_ERROR');

  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('a negative or non-integer action index is refused', async () => {
  const f = await pending();

  for (const index of [-1, 1.5, '0', null]) {
    const err = await rejects(() =>
      revise(f.repos, f.decision.id, { actions: [{ index, field: 'title', value: 'x' }] }),
    );
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR', `index ${String(index)} was accepted`);
  }

  const missing = await rejects(() =>
    revise(f.repos, f.decision.id, { actions: [{ field: 'title', value: 'x' }] }),
  );
  assert.match(JSON.stringify((missing as { details?: unknown }).details), /index.{0,3} is required/);

  await f.close();
});

test('an edit whose declared type disagrees with the action at that index is refused', async () => {
  const f = await pending();
  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      actions: [{ index: f.taskIndex, type: 'send_email', field: 'title', value: 'x' }],
    }),
  );
  assert.match(JSON.stringify((err as { details?: unknown }).details), /but action \d+ is .{0,3}create_task/);

  await f.close();
});

test('editing the same field twice is refused', async () => {
  const f = await pending();
  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      actions: [
        { index: f.taskIndex, field: 'title', value: 'First' },
        { index: f.taskIndex, field: 'title', value: 'Second' },
      ],
    }),
  );
  assert.match(JSON.stringify((err as { details?: unknown }).details), /twice/);

  await f.close();
});

test('malformed values are refused: due dates, priorities and over-long text', async () => {
  const f = await pending();

  const cases: Array<[string, unknown, RegExp]> = [
    ['dueAt', 'next tuesday', /ISO-8601/],
    ['dueAt', PAST, /in the future/],
    ['dueAt', 12345, /ISO-8601/],
    ['priority', 'urgent', /must be one of/],
    ['priority', 3, /must be one of/],
    ['title', '', /must not be empty/],
    ['title', 'x'.repeat(201), /at most 200/],
    ['title', 42, /must be a string/],
    ['description', 'x'.repeat(2001), /at most 2000/],
  ];

  for (const [field, value, pattern] of cases) {
    const err = await rejects(() =>
      revise(f.repos, f.decision.id, { actions: [{ index: f.taskIndex, field, value }] }),
    );
    const details = JSON.stringify((err as { details?: unknown }).details);
    assert.match(details, pattern, `${field}=${JSON.stringify(value)} was not refused clearly`);
  }

  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('a malformed draft edit is refused', async () => {
  const f = await pending();

  for (const draft of [
    { subject: '' },
    { subject: 'x'.repeat(201) },
    { body: 'x'.repeat(4001) },
    { subject: 42 },
    { headline: 'not a draft field' },
  ]) {
    const err = await rejects(() => revise(f.repos, f.decision.id, { draft }));
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR', `${JSON.stringify(draft)} was accepted`);
  }

  await f.close();
});

test('a draft cannot be edited into a plan that has no drafted reply', async () => {
  const f = await pending('demo-e07');
  assert.equal(f.decision.plan.draft, null);

  const err = await rejects(() => revise(f.repos, f.decision.id, { draft: { subject: 'Invented' } }));
  assert.match(JSON.stringify((err as { details?: unknown }).details), /no drafted reply/);

  await f.close();
});

test('every problem in a bad envelope is reported at once', async () => {
  const f = await pending();
  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      actions: [
        { index: f.taskIndex, field: 'priority', value: 'urgent' },
        { index: f.taskIndex, field: 'dueAt', value: PAST },
        { index: 999, field: 'title', value: 'x' },
      ],
    }),
  );
  const problems = (err as { details?: { problems?: string[] } }).details?.problems ?? [];
  assert.equal(problems.length, 3, 'a malformed edit should be one round trip to fix, not three');

  await f.close();
});

test('a revision cannot be pointed at another email through the repository', async () => {
  // The envelope has no field for it, so the only route is the repository —
  // where M4-C.1's provenance check refuses it.
  const a = await pending('demo-e01');
  const b = await pending('demo-e02');

  const err = await rejects(() =>
    a.repos.decisions.create({
      emailId: b.decision.emailId,
      analysisId: a.decision.analysisId,
      resolutionRun: a.decision.resolutionRun,
      plan: a.decision.plan,
      model: null,
      promptVersion: null,
      latencyMs: null,
      origin: 'human_edit',
      parentDecisionId: a.decision.id,
      editedBy: 'attacker',
    }),
  );
  assert.match(err.message, /same email|parent decision/i);

  await a.close();
  await b.close();
});

// ---------------------------------------------------------------------------
// 33, 34  guardrails
// ---------------------------------------------------------------------------

test('an edited reply that breaks a guardrail creates no revision', async () => {
  const f = await pending();

  const err = await rejects(() =>
    revise(f.repos, f.decision.id, {
      draft: { body: 'Hi Sarah,\n\nWe can do this for $499 per month and guarantee delivery within 2 weeks.\n\nSameer' },
    }),
  );

  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  const problems = JSON.stringify((err as { details?: unknown }).details);
  assert.match(problems, /no_price_commitment/);

  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');
  assert.deepEqual(await f.repos.approvals.getEdit(f.decision.id), null);

  await f.close();
});

test('a blocked edit is audited as draft_edit_blocked, with no text in the record', async () => {
  const f = await pending();

  await rejects(() =>
    revise(f.repos, f.decision.id, {
      draft: { body: 'Hi Sarah,\n\nHappy to offer a 20% discount if you sign this week.\n\nSameer' },
    }),
  );

  const events = await f.repos.audit.listByEmail(f.email.id);
  const blocked = events.find((event) => event.eventType === 'draft_edit_blocked');
  assert.ok(blocked, 'a blocked edit was not audited');
  assert.equal(blocked.actor, 'human');
  assert.equal(blocked.actorId, 'sameer');
  assert.equal(blocked.outcome, 'blocked');
  const blockedBy = (blocked.payload as { blockedBy?: string[] }).blockedBy ?? [];
  assert.ok(blockedBy.includes('no_discount_or_offer'), `expected no_discount_or_offer, got ${blockedBy.join(', ')}`);
  assert.ok(!JSON.stringify(blocked).includes('20% discount'), 'the blocked text was stored');

  // Refused, so no revision was audited either.
  assert.equal(events.filter((event) => event.eventType === 'plan_revised').length, 0);

  await f.close();
});

test('a human edit cannot weaken any of the six guardrails', async () => {
  const f = await pending();

  const attempts: Array<[string, string]> = [
    ['no_price_commitment', 'Our price is $2,000 for this.'],
    ['no_delivery_promise', 'We will deliver it within 3 weeks.'],
    ['no_discount_or_offer', 'I can offer you a free audit to get started.'],
    ['no_legal_or_contractual_language', 'We guarantee this outcome and accept liability for it.'],
    ['no_pii_echo', 'Copying in my colleague at someone-else@unrelated.example for this.'],
    ['no_invented_facts', 'Our clients typically see a 312% increase in recovered carts.'],
  ];

  for (const [guardrail, sentence] of attempts) {
    const err = await rejects(() =>
      revise(f.repos, f.decision.id, { draft: { body: `Hi Sarah,\n\n${sentence}\n\nSameer` } }),
    );
    assert.match(
      JSON.stringify((err as { details?: unknown }).details),
      new RegExp(guardrail),
      `${guardrail} did not stop a human edit`,
    );
  }

  assert.equal((await f.repos.decisions.listForEmail(f.email.id)).length, 1);

  await f.close();
});

test('a guardrail-safe edit is re-marked as having passed the checks', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, {
    draft: { body: 'Hi Sarah,\n\nThanks for getting in touch. When would suit you for a short call?\n\nSameer' },
  });

  assert.deepEqual(result.decision.plan.draft?.blockedBy, []);
  assert.equal(result.decision.plan.draft?.guardrailsPassed.length, 6);

  await f.close();
});

// ---------------------------------------------------------------------------
// 35–37  the policy floor
// ---------------------------------------------------------------------------

test('an edit cannot lower requiresApproval or the risk tier', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  assert.equal(f.decision.plan.requiresApproval, true);
  assert.equal(result.decision.plan.requiresApproval, true);
  assert.equal(result.decision.plan.riskTier, f.decision.plan.riskTier);

  await f.close();
});

test('loosening the autonomy setting between v1 and v2 cannot remove the approval requirement', async () => {
  // The one genuinely reachable route to a weaker recomputation, and the reason
  // the floor exists rather than being an assertion about the impossible.
  const f = await pending('demo-e05', 'manual');
  assert.equal(f.decision.plan.requiresApproval, true);
  assert.equal(f.decision.plan.riskTier, 0);

  await f.repos.settings.set('autonomy_level', 'autonomous_low_risk', 'test');
  const taskIndex = f.decision.plan.actions.findIndex((action) => action.type === 'create_task');

  const result = await revise(f.repos, f.decision.id, renameTask(taskIndex, 'Call Priya back'));

  assert.equal(result.decision.plan.requiresApproval, true, 'a settings change lowered the approval requirement');
  assert.ok(
    result.decision.plan.approvalReasons.some((reason) => reason.code === 'inherited_from_original'),
    'the floor engaged without explaining itself to the operator',
  );

  // And the executor agrees: v2 still cannot run without its own approval.
  const email = (await f.repos.emails.getById(f.email.id)) as EmailRecord;
  const refusal = await verifyExecutable(email, result.decision, f.repos, clock.nowIso());
  assert.equal(refusal?.code, 'approval_not_granted');

  await f.close();
});

test('the request cannot supply risk, approval or rationale', async () => {
  const f = await pending();

  // These keys are rejected outright by the envelope...
  for (const envelope of [
    { riskTier: 0 },
    { requiresApproval: false },
    { approvalReasons: [] },
    { rationale: 'trust me' },
    { ruleTrace: [] },
  ]) {
    const err = await rejects(() => revise(f.repos, f.decision.id, envelope));
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  }

  // ...and the fields they name are recomputed regardless.
  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));
  assert.equal(result.decision.plan.rationale, f.decision.plan.rationale);
  assert.deepEqual(result.decision.plan.ruleTrace, f.decision.plan.ruleTrace);

  await f.close();
});

// ---------------------------------------------------------------------------
// 45  atomicity
// ---------------------------------------------------------------------------

/**
 * A database that fails on one statement, propagating the fault into nested
 * transactions so a repository bound to `tx` meets it too.
 */
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

test('a failure part-way through leaves no v2, no v2 approval and no partial audit', async () => {
  const f = await pending();

  // Repositories bound to a database that refuses the audit insert — the last
  // write in the transaction, so v2 and both approvals are already staged.
  const faulty = createRepositories(failingOn(f.repos.db, /INSERT INTO audit_events/i), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('faulty'),
  });

  const err = await rejects(() => revise(faulty, f.decision.id, renameTask(f.taskIndex)));
  assert.match(err.message, /injected failure/);

  // Everything rolled back together.
  const decisions = await f.repos.decisions.listForEmail(f.email.id);
  assert.equal(decisions.length, 1, 'an orphan revision survived the rollback');
  assert.equal(decisions[0]?.id, f.decision.id);
  assert.equal(decisions[0]?.supersededBy, null, 'v1 was left pointing at a revision that does not exist');
  assert.equal((await f.repos.approvals.getForDecision(f.decision.id))?.state, 'pending');
  assert.equal(await f.repos.approvals.count(), 7);

  const events = await f.repos.audit.listByEmail(f.email.id);
  assert.equal(events.filter((event) => event.eventType === 'plan_revised').length, 0);
  assert.equal(events.filter((event) => event.eventType === 'approval_superseded').length, 0);

  // And the plan is still editable afterwards, because nothing about it moved.
  const retried = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));
  assert.equal(retried.revision, 2);

  await f.close();
});

// ---------------------------------------------------------------------------
// 48, 49  the endpoint
// ---------------------------------------------------------------------------

test('a revision works through the HTTP endpoint and records the caller as the editor', async () => {
  const f = await pending();
  // M5-A: the API requires a session, so the test signs in exactly as a browser
  // would. The editor recorded is the authenticated operator, not a header.
  const server = await startAuthenticatedServer(f.db);

  try {
    const response = await fetch(`${server.url}/api/decisions/${f.decision.id}/revise`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: server.cookie,
        'x-csrf-token': server.csrf,
      },
      body: JSON.stringify({ edits: { draft: { subject: 'A calmer subject line' } } }),
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, any>;

    assert.equal(body.revision, 2);
    assert.equal(body.parentDecisionId, f.decision.id);
    assert.equal(body.decision.origin, 'human_edit');
    assert.equal(body.decision.editedBy, 'operator', 'the editor was not the authenticated operator');
    assert.equal(body.approval.state, 'pending');
    assert.equal(body.supersededApproval.state, 'superseded');
    assert.equal(body.diff.length, 1);
    assert.equal(body.diff[0].path, 'draft.subject');
  } finally {
    await server.stop();
  }

  await f.close();
});

test('the handler defaults the editor to the calling operator and answers 201', async () => {
  const f = await pending();

  const result = await handleRevise(
    deps(f.repos),
    f.decision.id,
    { edits: { draft: { subject: 'Renamed by the operator' } } },
    'priya',
  );

  assert.equal(result.status, 201);
  assert.equal(result.body.decision.editedBy, 'priya', 'an edit was recorded without an editor');
  assert.equal(result.body.approval.state, 'pending');
  assert.equal(result.body.detail.decision?.id, result.body.decision.id);

  await f.close();
});

test('an error response names the field, never the email body or a secret', async () => {
  const f = await pending();
  const server = await startAuthenticatedServer(f.db);

  try {
    const response = await fetch(`${server.url}/api/decisions/${f.decision.id}/revise`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: server.cookie,
        'x-csrf-token': server.csrf,
      },
      body: JSON.stringify({ edits: { actions: [{ index: f.taskIndex, field: 'dueAt', value: PAST }] } }),
    });

    assert.equal(response.status, 400);
    const text = await response.text();

    assert.match(text, /in the future/);
    assert.ok(!text.includes(f.email.bodyText.slice(0, 40)), 'the response echoed the email body');
    assert.ok(!/sk-|api[_-]?key|password|secret/i.test(text), 'the response mentioned a credential');
  } finally {
    await server.stop();
  }

  await f.close();
});

test('the envelope validator is pure: it never touches the plan it was given', async () => {
  const f = await pending();
  const snapshot = structuredClone(f.decision.plan);

  validateEditEnvelope(
    { actions: [{ index: f.taskIndex, field: 'title', value: 'Something else' }] },
    f.decision.plan,
    clock.nowIso(),
  );

  assert.deepEqual(f.decision.plan, snapshot);

  await f.close();
});

test('the email detail carries the whole revision history, oldest first', async () => {
  // M4-C.3 reads this to render the history. It comes from the API precisely so
  // the UI never has to reconstruct it from the audit log, whose payloads are
  // paths and digests by design and could not answer "what state is v1 in?".
  const f = await pending();

  const before = await handleGetEmail(deps(f.repos), f.email.id);
  assert.equal(before.body.revisions.length, 1);
  assert.deepEqual(before.body.revisions[0], {
    id: f.decision.id,
    revision: 1,
    origin: 'agent',
    editedBy: null,
    parentDecisionId: null,
    createdAt: f.decision.createdAt,
    approvalState: 'pending',
    isCurrent: true,
  });

  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));
  const after = await handleGetEmail(deps(f.repos), f.email.id);

  assert.equal(after.body.revisions.length, 2);
  assert.deepEqual(
    after.body.revisions.map((entry) => [entry.revision, entry.origin, entry.approvalState, entry.isCurrent]),
    [
      [1, 'agent', 'superseded', false],
      [2, 'human_edit', 'pending', true],
    ],
  );
  assert.equal(after.body.revisions[1]?.editedBy, 'sameer');
  assert.equal(after.body.revisions[1]?.parentDecisionId, f.decision.id);
  assert.equal(after.body.revisions[1]?.id, result.decision.id);

  await f.close();
});

test('the email detail returned after a revision shows the revision as current', async () => {
  const f = await pending();
  const result = await revise(f.repos, f.decision.id, renameTask(f.taskIndex));

  const detail = await handleGetEmail(deps(f.repos), f.email.id);
  assert.equal(detail.body.decision?.id, result.decision.id);
  assert.equal(detail.body.decision?.revision, 2);
  assert.equal(detail.body.approval?.state, 'pending');

  await f.close();
});
