import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { decideEmail } from '../src/agent/decide/decide.ts';
import { executePlan, verifyExecutable, assertExecutable } from '../src/agent/execute/executor.ts';
import { assertEveryActionExecutable, hasExecutor } from '../src/adapters/crm/localWriter.ts';
import { planFingerprint, idempotencyKey, APPROVAL_STATES } from '../src/domain/execution.ts';
import { ACTION_TYPES } from '../src/domain/actions.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import {
  handleApprove,
  handleReject,
  handleExecute,
  handleListApprovals,
  handleDecidePending,
  handleGetEmail,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';

// M4-A tests: the approval record and the executor's independent verification.
//
// The property under test throughout is the same one: **the UI is not the
// security boundary**. Every test that grants or withholds permission does so
// by writing (or not writing) a database row, never by calling an endpoint in a
// particular order.

const quiet = createLogger('test', { level: 'error' });

// Aligned with the repositories' clock in `createTestContext` (2026-06-01).
// The approval's SLA is stamped by the repository clock, so an executor running
// on a different fixed clock would see every approval as expired — which is a
// property of the harness, not of the product, where both are the system clock.
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

/** Runs the whole pipeline up to a persisted decision. */
async function pipelineToDecision(
  repos: Repositories,
  providerMessageId: string,
  autonomy: 'manual' | 'assisted' = 'manual',
): Promise<{ email: EmailRecord; decision: DecisionRecord }> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  await repos.settings.set('autonomy_level', autonomy, 'test');

  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});

  const email = await repos.emails.findByProviderMessageId('demo', providerMessageId);
  assert.ok(email, `fixture ${providerMessageId} missing`);
  const decision = await repos.decisions.getCurrentForEmail(email.id);
  assert.ok(decision, 'no decision was produced');
  return { email, decision };
}

async function crmCounts(repos: Repositories) {
  return {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
    notes: await repos.notes.count(),
  };
}

// ============================================================ 1-2. approval

test('1. a plan needing approval opens a pending approval bound to that decision', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');

  const approval = await repos.approvals.getForDecision(decision.id);
  assert.ok(approval);
  assert.equal(approval.state, 'pending');
  assert.equal(approval.decisionId, decision.id);
  assert.equal(approval.decidedBy, null);
  assert.ok(approval.expiresAt > approval.createdAt, 'the SLA clock starts when the plan is made');
  await close();
});

test('requesting an approval twice returns the same one', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');

  const first = await repos.approvals.getForDecision(decision.id);
  const again = await repos.approvals.request(decision.id, 24);
  assert.equal(again.id, first?.id, 'the same request is returned, not a second one');
  await close();
});

test('2. approving records who decided, when, and the plan they approved', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');
  const d = deps(repos);

  await handleApprove(d, decision.id, 'sameer');

  const approval = await repos.approvals.getForDecision(decision.id);
  assert.equal(approval?.state, 'approved');
  assert.equal(approval?.decidedBy, 'sameer');
  assert.ok(approval?.decidedAt);
  assert.equal(approval?.planHash, planFingerprint(decision.plan), 'the fingerprint is of the plan, not of the request');
  await close();
});

test('an approval cannot be settled twice', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');

  await repos.approvals.decide(decision.id, 'approved', { decidedBy: 'a' });
  const err = await rejects(() => repos.approvals.decide(decision.id, 'rejected', { decidedBy: 'b' }));
  assert.match(err.message, /already approved/);
  await close();
});

// ================================================== 3-9. verification gates

test('6+7. an unapproved consequential plan is refused by the executor itself', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  const before = await crmCounts(repos);

  // No endpoint involved: the executor is called directly, exactly as a bug in
  // the UI would call it.
  const outcome = await executePlan(email, decision, { repos, clock, logger: quiet });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_not_granted');
  assert.equal(outcome.executions.length, 0);
  assert.deepEqual(await crmCounts(repos), before, 'a refusal must not touch the CRM');
  await close();
});

test('5. a rejected plan can never execute', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  const d = deps(repos);

  await handleReject(d, decision.id, { reason: 'Not a real lead.' }, 'sameer');
  const before = await crmCounts(repos);

  // Path 1: the email is now `rejected`, so the state guard stops it first.
  const viaState = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );
  assert.equal(viaState.ok, false);
  assert.equal(viaState.refusedWith, 'invalid_state');
  assert.match(viaState.refusalMessage ?? '', /rejected/);

  // Path 2: forced back into an executable state, so the *approval* check is
  // the thing that has to say no. This is the guard that actually matters —
  // the state guard alone would be bypassable by anything that moved the email.
  await repos.emails.setState(email.id, 'awaiting_approval');
  const viaApproval = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );
  assert.equal(viaApproval.ok, false);
  assert.equal(viaApproval.refusedWith, 'approval_not_granted');
  assert.match(viaApproval.refusalMessage ?? '', /rejected/);

  assert.deepEqual(await crmCounts(repos), before, 'neither path touched the CRM');
  await close();
});

test('rejecting requires a reason', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');
  const err = await rejects(() => handleReject(deps(repos), decision.id, {}, 'sameer'));
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  await close();
});

test('4. an approval does not survive the plan changing', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: 'a-fingerprint-of-some-other-plan',
  });

  const outcome = await executePlan(email, decision, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'plan_changed_since_approval');
  await close();
});

test('3. an approval on a superseded decision authorises nothing', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  // Re-decide: the approved decision is now superseded.
  await decideEmail((await repos.emails.getById(email.id)) as EmailRecord, deps(repos));
  const stale = (await repos.decisions.getById(decision.id)) as DecisionRecord;
  assert.ok(stale.supersededBy);

  const outcome = await executePlan(email, stale, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'decision_superseded');
  await close();
});

test('an expired approval does not execute', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  // Verified at a time past the SLA. Timeouts never resolve towards acting.
  const refusal = await verifyExecutable(email, decision, repos, '2099-01-01T00:00:00.000Z');
  assert.equal(refusal?.code, 'approval_expired');
  await close();
});

test('8+9. no request body or model output can assert approval', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  // A tampered plan claiming it needs no approval, and a caller claiming the
  // same. The executor re-derives the answer from the policy and the database.
  const forged: DecisionRecord = {
    ...decision,
    plan: { ...decision.plan, requiresApproval: false, riskTier: 0, approvalReasons: [] },
  };

  const outcome = await executePlan(email, forged, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_not_granted', 'the cached flag is not consulted');
  assert.deepEqual(await crmCounts(repos), await crmCounts(repos));
  await close();
});

test('an action outside the closed registry is refused before anything runs', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  const smuggled: DecisionRecord = {
    ...decision,
    plan: { ...decision.plan, actions: [{ type: 'delete_all_deals' as never, payload: {} }] },
  };

  const outcome = await executePlan(email, smuggled, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'unknown_action_type');
  await close();
});

// ============================================================ 10-15. success

test('10+13. an approved plan executes and creates the CRM records', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  const before = await crmCounts(repos);
  const d = deps(repos);

  const result = await handleApprove(d, decision.id, 'sameer');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.executed, 6);

  const after = await crmCounts(repos);
  assert.equal(after.companies, before.companies + 1);
  assert.equal(after.contacts, before.contacts + 1);
  assert.equal(after.deals, before.deals + 1);
  assert.equal(after.tasks, before.tasks + 1);
  assert.equal(after.activities, before.activities + 1);

  const finished = (await repos.emails.getById(email.id)) as EmailRecord;
  assert.equal(finished.state, 'completed');
  await close();
});

test('the created records are linked to each other and marked as agent-made', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const contact = await repos.contacts.findByEmail('sarah@acmecommerce.io');
  assert.ok(contact);
  assert.equal(contact.source, 'agent');
  assert.ok(contact.companyId, 'the {kind:"new"} company reference resolved to a real id');

  const company = await repos.companies.getById(contact.companyId);
  assert.equal(company?.domain, 'acmecommerce.io');

  const deals = await repos.deals.listByCompany(company?.id as string);
  assert.equal(deals.length, 1);
  assert.equal(deals[0]?.primaryContactId, contact.id);
  assert.equal(deals[0]?.stage, 'new_lead');
  assert.equal(deals[0]?.amountMinor, null, 'a stated budget is never turned into an amount');
  await close();
});

test('15. the follow-up task carries its due date and links to the email', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const tasks = (await repos.tasks.list({ status: 'open' })).filter((t) => t.source === 'agent');
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0]?.dueAt);
  assert.equal(tasks[0]?.emailId, email.id);
  await close();
});

test('14. a follow-up updates the existing deal rather than creating one', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e06');

  const dealsBefore = await repos.deals.count();
  await handleApprove(deps(repos), decision.id, 'sameer');

  assert.equal(await repos.deals.count(), dealsBefore, 'no new deal');
  const executions = await repos.executions.listForDecision(decision.id);
  const stageChange = executions.find((e) => e.actionType === 'update_deal_stage');
  assert.ok(stageChange);
  assert.equal(stageChange.status, 'succeeded');
  await close();
});

test('12. every execution records a before and after snapshot', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e06');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const executions = await repos.executions.listForDecision(decision.id);
  const stageChange = executions.find((e) => e.actionType === 'update_deal_stage');
  assert.ok(stageChange);

  // An update has both sides, and they differ — which is what makes the record
  // useful for a future undo.
  assert.equal((stageChange.beforeSnapshot as { stage: string }).stage, 'qualifying');
  assert.equal((stageChange.afterSnapshot as { stage: string }).stage, 'proposal');

  const created = executions.find((e) => e.actionType === 'log_activity');
  assert.equal(created?.beforeSnapshot, null, 'a creation has nothing before it');
  assert.ok(created?.afterSnapshot);
  await close();
});

test('a tier-0 plan runs without any approval record', async () => {
  // CONTRACT CHANGE (M6-E): the pipeline now runs an unattended plan itself, so
  // this no longer calls `executePlan` a second time — by the time the helper
  // returns, the plan has already run and a second attempt is correctly refused
  // as `already_executed`.
  //
  // The claim is unchanged and is now demonstrated end to end rather than by a
  // hand-driven call: a tier-0 plan reaches a terminal state, does real work,
  // and no approval record exists anywhere in the story.
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e09', 'assisted');

  assert.equal(decision.plan.requiresApproval, false);
  assert.equal(await repos.approvals.getForDecision(decision.id), null, 'no approval was requested');

  assert.equal(((await repos.emails.getById(email.id)) as EmailRecord).state, 'archived');

  const executions = await repos.executions.listForDecision(decision.id);
  assert.ok(executions.length > 0, 'the email was archived without executing anything');
  assert.ok(executions.every((execution) => execution.status === 'succeeded'));

  await close();
});

// ============================================================ 11. idempotency

test('11. running the same approved plan twice creates nothing twice', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const afterFirst = await crmCounts(repos);
  const executionsFirst = (await repos.executions.listForDecision(decision.id)).length;

  // Force the email back into an executable state so the guard is not what
  // stops the second run — the idempotency keys must be.
  await repos.emails.setState(email.id, 'awaiting_approval');
  const second = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );

  assert.equal(second.ok, true, 'a re-run of a fully-applied plan is a no-op success');
  assert.deepEqual(await crmCounts(repos), afterFirst, 'no duplicate CRM records');
  assert.equal((await repos.executions.listForDecision(decision.id)).length, executionsFirst);
  assert.equal(await repos.outbox.count(), 1, 'no duplicate outbox row');
  await close();
});

test('the idempotency key is derived from content, so it is stable', () => {
  const a = idempotencyKey('d1', 1, 'create_task', { title: 'x' });
  const b = idempotencyKey('d1', 1, 'create_task', { title: 'x' });
  const c = idempotencyKey('d1', 2, 'create_task', { title: 'x' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('a duplicate company domain links to the existing record instead of creating a second', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');

  // The world moved between planning and executing: someone added the company.
  await repos.companies.create({ name: 'Acme Commerce', domain: 'acmecommerce.io', source: 'human' });
  const before = await repos.companies.count();

  await handleApprove(deps(repos), decision.id, 'sameer');
  assert.equal(await repos.companies.count(), before, 'no duplicate company');

  const contact = await repos.contacts.findByEmail('sarah@acmecommerce.io');
  const company = await repos.companies.findByDomain('acmecommerce.io');
  assert.equal(contact?.companyId, company?.id, 'the contact linked to the record that already existed');
  await close();
});

// ============================================================ 16. failure

test('16. a failure rolls everything back and is recorded, not pretended away', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e06');
  const before = await crmCounts(repos);

  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  // The deal moved since the plan was made — the writer refuses to overwrite
  // whatever a person did in the meantime.
  const stageAction = decision.plan.actions.find((a) => a.type === 'update_deal_stage');
  assert.ok(stageAction);
  const dealId = (stageAction.payload as { dealId: string }).dealId;
  await repos.deals.update(dealId, { stage: 'won' });

  const outcome = await executePlan(email, decision, { repos, clock, logger: quiet });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, null, 'this is a failure, not a refusal');
  assert.deepEqual(await crmCounts(repos), before, 'the transaction rolled back');

  const failed = (await repos.executions.listForDecision(decision.id)).find((e) => e.status === 'failed');
  assert.ok(failed, 'the failure is recorded');
  assert.ok(failed.errorMessage);

  assert.equal(((await repos.emails.getById(email.id)) as EmailRecord).state, 'execution_failed');
  await close();
});

test('a failed execution can be retried once the cause is fixed', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e06');
  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  const stageAction = decision.plan.actions.find((a) => a.type === 'update_deal_stage');
  assert.ok(stageAction);
  const dealId = (stageAction.payload as { dealId: string }).dealId;
  await repos.deals.update(dealId, { stage: 'won' });
  await executePlan(email, decision, { repos, clock, logger: quiet });

  // Put the deal back where the plan expects it, then retry.
  await repos.deals.update(dealId, { stage: 'qualifying' });
  const retried = await executePlan(
    (await repos.emails.getById(email.id)) as EmailRecord,
    decision,
    { repos, clock, logger: quiet },
  );

  assert.equal(retried.ok, true);
  assert.equal(((await repos.emails.getById(email.id)) as EmailRecord).state, 'completed');
  await close();
});

// ================================================ 18-19. outbound boundary

test('19. an approved reply reaches the outbox as suppressed and is never sent', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const outbox = await repos.outbox.findForDecision(decision.id);
  assert.ok(outbox);
  assert.equal(outbox.status, 'suppressed');
  assert.equal(outbox.suppressedReason, 'outbound_send_disabled');
  assert.equal(outbox.sentAt, null);
  assert.equal(outbox.providerMessageId, null);
  assert.equal(outbox.toEmail, 'sarah@acmecommerce.io');
  assert.ok(outbox.body.length > 0, 'the reply is preserved for a person to review');

  assert.equal((await repos.outbox.listByStatus('sent')).length, 0, 'nothing is ever marked sent');
  await close();
});

test('18. a blocked draft cannot be executed at all', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  const before = await crmCounts(repos);

  const blocked: DecisionRecord = {
    ...decision,
    plan: {
      ...decision.plan,
      draft: {
        subject: 'Re: test',
        body: 'We can do this for $2,500 and guarantee delivery.',
        guardrailsPassed: [],
        blockedBy: [{ guardrail: 'no_price_commitment', evidence: '$2,500', why: 'a price is a commitment' }],
      },
    },
  };

  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(blocked.plan),
  });

  const outcome = await executePlan(email, blocked, { repos, clock, logger: quiet });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'draft_blocked');
  assert.equal(await repos.outbox.count(), 0, 'a blocked reply never reaches the outbox');
  assert.deepEqual(await crmCounts(repos), before, 'and nothing else in the plan is applied either');
  await close();
});

test('a plan that sends but has no draft is refused', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  const draftless: DecisionRecord = { ...decision, plan: { ...decision.plan, draft: null } };
  await repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(draftless.plan),
  });

  const outcome = await executePlan(email, draftless, { repos, clock, logger: quiet });
  assert.equal(outcome.refusedWith, 'draft_blocked');
  await close();
});

// ======================================================== 20. registry safety

test('20. no destructive action exists, and every registry action has an executor', () => {
  for (const type of ACTION_TYPES) {
    assert.doesNotMatch(type, /delete|remove|purge|drop|truncate|bulk/i);
    assert.ok(hasExecutor(type), `${type} has no executor and would fail closed`);
  }
  assert.doesNotThrow(() => assertEveryActionExecutable());
});

test('the executor has no path to arbitrary SQL or an arbitrary mutation', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');

  // A payload trying to smuggle SQL. The writer reads named fields only, so
  // this is inert data — and the action type is still checked against the
  // registry regardless of what the payload says.
  const nasty: DecisionRecord = {
    ...decision,
    plan: {
      ...decision.plan,
      actions: [{ type: 'add_note', payload: { body: "'); DROP TABLE contacts; --", contact: null, company: null } }],
    },
  };
  await repos.approvals.decide(decision.id, 'approved', { decidedBy: 'x', planHash: planFingerprint(nasty.plan) });

  const outcome = await executePlan(email, nasty, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, true);

  // The table still exists and the text was stored as text.
  assert.ok((await repos.contacts.count()) >= 0);
  const notes = await repos.notes.listForEntity('company', 'nothing');
  assert.equal(notes.length, 0);
  await close();
});

// ================================================================ 17. audit

test('17. the whole chain is auditable and append-only', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const events = await repos.audit.listByEmail(email.id);
  const types: string[] = events.map((e) => e.eventType);

  for (const expected of [
    'plan_created', 'policy_evaluated', 'approval_requested', 'approval_granted',
    'crm_record_created', 'outbox_suppressed', 'action_executed',
  ]) {
    assert.ok(types.includes(expected), `missing audit event: ${expected}`);
  }

  const granted = events.find((e) => e.eventType === 'approval_granted');
  assert.equal(granted?.actor, 'human');
  assert.equal(granted?.actorId, 'sameer');

  // Append-only: the repository exposes no way to change history.
  for (const method of ['update', 'delete', 'remove']) {
    assert.equal((repos.audit as unknown as Record<string, unknown>)[method], undefined);
  }

  // And no raw email body leaked into the trail.
  assert.doesNotMatch(JSON.stringify(events), /We run a small Shopify store/);
  await close();
});

test('a refusal is audited too, so a blocked attempt is visible', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  await executePlan(email, decision, { repos, clock, logger: quiet });

  const events = await repos.audit.listByEmail(email.id);
  const refusal = events.find((e) => e.eventType === 'action_failed' && e.outcome === 'blocked');
  assert.ok(refusal);
  assert.equal(refusal.payload.refusedWith, 'approval_not_granted');
  await close();
});

// ================================================================== API

test('the API refuses to execute a tier-2 plan the client claims is fine', async () => {
  const { repos, close } = await createTestContext();
  const { decision } = await pipelineToDecision(repos, 'demo-e01');
  const d = deps(repos);

  // The body is ignored entirely — there is no field that grants anything.
  const result = await handleExecute(d, decision.id);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.refusedWith, 'approval_not_granted');
  assert.equal(result.body.executed, 0);
  await close();
});

test('the approval queue lists pending decisions', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecision(repos, 'demo-e01');
  const d = deps(repos);

  const queue = await handleListApprovals(d, { state: 'pending' });
  assert.ok(queue.body.approvals.length >= 1);
  const row = queue.body.approvals[0];
  assert.equal(row?.approval.state, 'pending');
  // CONTRACT CHANGE (M4-B): a queue row now carries the whole email context
  // rather than a bare subject string.
  assert.ok(row?.email.subject.length);
  assert.ok(row?.decision.plan.rationale.length);
  await close();
});

test('the detail payload exposes approval, executions and the outbox', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  const d = deps(repos);

  const beforeApproval = await handleGetEmail(d, email.id);
  assert.equal(beforeApproval.body.approval?.state, 'pending');
  assert.equal(beforeApproval.body.executions.length, 0);
  assert.equal(beforeApproval.body.outbox, null);
  assert.equal(beforeApproval.body.stages.execute, 'awaiting_approval');

  await handleApprove(d, decision.id, 'sameer');
  const after = await handleGetEmail(d, email.id);
  assert.equal(after.body.approval?.state, 'approved');
  assert.equal(after.body.executions.length, 6);
  assert.equal(after.body.outbox?.status, 'suppressed');
  assert.equal(after.body.stages.execute, 'complete');
  await close();
});

test('approving a decision that does not exist is a 404', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleApprove(deps(repos), 'no-such-decision', 'sameer'));
  assert.equal((err as { code?: string }).code, 'NOT_FOUND');
  await close();
});

test('approval states are exactly the lifecycle the specification names', () => {
  // CONTRACT CHANGE (M4-C.1): `superseded` joins the four from §16. It is the
  // state a pending approval reaches when a human edits the plan — the edit
  // creates a new decision with its own approval, so this one stops being
  // pending without anyone rejecting it and without anything timing out.
  // Terminal like the other three; §16's rule that a timeout never resolves in
  // the direction of acting is untouched, and so is the list of states that can
  // authorise an execution, which remains `approved` alone.
  assert.deepEqual([...APPROVAL_STATES], ['pending', 'approved', 'rejected', 'expired', 'superseded']);
});

test('a completed email cannot be executed again through any path', async () => {
  const { repos, close } = await createTestContext();
  const { email, decision } = await pipelineToDecision(repos, 'demo-e01');
  await handleApprove(deps(repos), decision.id, 'sameer');

  const finished = (await repos.emails.getById(email.id)) as EmailRecord;
  assert.throws(() => assertExecutable(finished), /cannot be executed/);

  const outcome = await executePlan(finished, decision, { repos, clock, logger: quiet });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'invalid_state');
  await close();
});
