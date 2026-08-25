import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { decideEmail, assertDecidable } from '../src/agent/decide/decide.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { handleDecideEmail, handleDecidePending, handleGetEmail, handleIngest, handleListEmails, handleResolvePending, handleUnderstandPending } from '../src/handlers/emails.ts';
import { runDecideEvaluation, decideThresholdFailures } from '../src/eval/decide/runner.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';
import type { LlmProvider, LlmResponse } from '../src/adapters/llm/types.ts';

// M3 integration tests: the real DECIDE stage over the real pipeline.
// Only the model call is substituted, and it only ever produces draft prose.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-09-01T00:00:00.000Z', 1000);

function deps(repos: Repositories, provider?: LlmProvider) {
  const mock = createMockLlmProvider();
  registerDemoFixtures(mock, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider: provider ?? mock,
    logger: quiet,
    clock,
  };
}

/** Seeds, ingests, understands and resolves — everything up to DECIDE. */
async function pipelineToDecide(repos: Repositories, autonomy?: 'manual' | 'assisted'): Promise<void> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  if (autonomy) await repos.settings.set('autonomy_level', autonomy, 'test');
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
}

async function emailFor(repos: Repositories, providerMessageId: string): Promise<EmailRecord> {
  const email = await repos.emails.findByProviderMessageId('demo', providerMessageId);
  assert.ok(email, `fixture ${providerMessageId} missing`);
  return email;
}

function scripted(fn: () => LlmResponse | Error): LlmProvider {
  return {
    name: 'mock',
    configured: true,
    async complete() {
      const result = fn();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// ============================================================== end-to-end

test('the hero lead produces the plan the specification describes', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const outcome = await decideEmail(await emailFor(repos, 'demo-e01'), deps(repos));
  const plan = outcome.plan;
  assert.ok(plan);

  assert.deepEqual(plan.actions.map((a) => a.type), [
    'create_company', 'create_contact', 'log_activity', 'create_deal', 'create_task', 'send_email',
  ]);
  assert.equal(plan.riskTier, 2);
  assert.equal(plan.requiresApproval, true);
  assert.ok(plan.draft, 'a discovery reply is drafted');
  assert.equal(plan.draft.blockedBy.length, 0);
  assert.equal(outcome.state, 'awaiting_approval');
  await close();
});

test('a support request gets a task and no drafted reply', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const outcome = await decideEmail(await emailFor(repos, 'demo-e05'), deps(repos));
  const plan = outcome.plan;
  assert.ok(plan);

  assert.deepEqual(plan.actions.map((a) => a.type), ['log_activity', 'create_task']);
  assert.equal(plan.riskTier, 0);
  assert.equal(plan.draft, null, 'a support request is not answered by a sales draft');
  assert.equal(plan.requiresApproval, false, 'tier 0 runs unattended under assisted autonomy');
  assert.equal(outcome.state, 'deciding');
  await close();
});

test('the pricing request drafts a reply that quotes no price', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const outcome = await decideEmail(await emailFor(repos, 'demo-e03'), deps(repos));
  const draft = outcome.plan?.draft;
  assert.ok(draft);

  // The most tempting case in the dataset: they stated a budget and asked what
  // it buys. The guardrail has to hold precisely here.
  assert.equal(draft.blockedBy.length, 0);
  assert.ok(draft.guardrailsPassed.includes('no_price_commitment'));
  assert.doesNotMatch(draft.body, /[$£€₹]\s?\d/);
  await close();
});

test('a follow-up advances the open deal instead of creating one', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const outcome = await decideEmail(await emailFor(repos, 'demo-e06'), deps(repos));
  const types = outcome.plan?.actions.map((a) => a.type) ?? [];

  assert.ok(types.includes('update_deal_stage'));
  assert.ok(!types.includes('create_deal'));
  assert.equal(outcome.plan?.riskTier, 2, 'moving a deal is consequential');
  assert.equal(outcome.state, 'awaiting_approval');
  await close();
});

test('a partnership gets a note and no pipeline entry', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const outcome = await decideEmail(await emailFor(repos, 'demo-e07'), deps(repos));
  const types = outcome.plan?.actions.map((a) => a.type) ?? [];

  assert.ok(types.includes('add_note'));
  assert.ok(!types.includes('create_deal'));
  assert.ok(!types.includes('send_email'));
  assert.equal(outcome.plan?.draft, null);
  await close();
});

test('spam is archived and creates nothing', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const outcome = await decideEmail(await emailFor(repos, 'demo-e09'), deps(repos));
  assert.deepEqual(outcome.plan?.actions.map((a) => a.type), ['archive_email']);
  assert.equal(outcome.plan?.requiresApproval, false);
  await close();
});

// ================================ emails DECIDE must never see (8, 9, 10)

test('an ambiguous email never reaches DECIDE, and produces no plan if forced', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const ambiguous = await emailFor(repos, 'demo-e08');
  assert.equal(ambiguous.state, 'needs_review', 'M1 holds it');
  assert.throws(() => assertDecidable(ambiguous), /cannot be decided/);

  // Forced through anyway: still no plan, and no CRM record proposed.
  await repos.emails.setState(ambiguous.id, 'deciding');
  const outcome = await decideEmail((await repos.emails.getById(ambiguous.id)) as EmailRecord, deps(repos));
  assert.deepEqual(outcome.plan?.actions, []);
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'no_valid_plan');
  await close();
});

test('an injected email never reaches DECIDE', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const injected = await emailFor(repos, 'demo-e10');
  assert.equal(injected.state, 'needs_review');
  assert.throws(() => assertDecidable(injected), /cannot be decided/);
  await close();
});

test('a match conflict never reaches DECIDE, and forces approval if it does', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const conflicted = await emailFor(repos, 'demo-e04');
  assert.equal(conflicted.state, 'needs_review');
  assert.equal(conflicted.reviewReason, 'match_conflict');

  await repos.emails.setState(conflicted.id, 'deciding');
  const outcome = await decideEmail((await repos.emails.getById(conflicted.id)) as EmailRecord, deps(repos));

  assert.equal(outcome.plan?.requiresApproval, true);
  assert.ok(outcome.plan?.approvalReasons.some((r) => r.code === 'match_conflict'));
  await close();
});

test('a low-confidence reading forces approval even for a safe plan', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const email = await emailFor(repos, 'demo-e05');
  const analysis = await repos.analyses.getLatestForEmail(email.id);
  assert.ok(analysis);

  // Re-persist the same reading with a low band — the plan is unchanged, the
  // policy answer must not be.
  await repos.analyses.create({
    emailId: email.id,
    understanding: { ...analysis.understanding, confidence: 0.3, confidenceBand: 'low' },
    modelOutput: analysis.modelOutput,
    validation: analysis.validation,
    security: analysis.security,
    model: 'mock',
    promptVersion: 'understand.v1',
    latencyMs: 0,
    attempt: 1,
  });

  const outcome = await decideEmail(email, deps(repos));
  assert.equal(outcome.plan?.riskTier, 0);
  assert.equal(outcome.plan?.requiresApproval, true);
  assert.ok(outcome.plan?.approvalReasons.some((r) => r.code === 'confidence_not_high'));
  await close();
});

// ================================================= draft failure handling

test('17. a drafting provider failure does not lose the plan', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const failing = scripted(() => new Error('connect ECONNREFUSED'));
  const outcome = await decideEmail(await emailFor(repos, 'demo-e01'), deps(repos, failing));

  assert.ok(outcome.plan);
  assert.equal(outcome.plan.actions.length, 6, 'the deterministic plan survives');
  assert.equal(outcome.plan.draft, null);
  assert.match(outcome.plan.draftFailedReason ?? '', /could not be reached/);
  assert.equal(outcome.plan.requiresApproval, true, 'a person must write the reply');
  assert.equal(outcome.state, 'awaiting_approval');
  await close();
});

test('malformed draft output is rejected without failing the decision', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const bad = scripted(() => ({ toolInput: { subject: '', body: '' }, model: 'mock', latencyMs: 0, stopReason: 'tool_use' }));
  const outcome = await decideEmail(await emailFor(repos, 'demo-e01'), deps(repos, bad));

  assert.equal(outcome.plan?.draft, null);
  assert.match(outcome.plan?.draftFailedReason ?? '', /could not be read/);
  assert.equal(outcome.plan?.requiresApproval, true);
  await close();
});

test('16. a draft that invents a price is blocked, kept visible, and forces approval', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const pushy = scripted(() => ({
    toolInput: {
      subject: 'Re: Shopify AI chatbot project',
      body: 'Hi Sarah, we can build this for $2,500 and guarantee delivery within 2 weeks. Regards',
    },
    model: 'mock',
    latencyMs: 0,
    stopReason: 'tool_use',
  }));

  const outcome = await decideEmail(await emailFor(repos, 'demo-e01'), deps(repos, pushy));
  const draft = outcome.plan?.draft;
  assert.ok(draft);

  const blocked = draft.blockedBy.map((v) => v.guardrail);
  assert.ok(blocked.includes('no_price_commitment'));
  assert.ok(blocked.includes('no_legal_or_contractual_language'));

  // Spec §16: the blocked text is still shown, so the operator sees what it tried to say.
  assert.match(draft.body, /\$2,500/);
  assert.equal(outcome.plan?.requiresApproval, true);
  assert.ok(outcome.plan?.approvalReasons.some((r) => r.code === 'draft_blocked'));
  await close();
});

// ================================================= model cannot decide (security)

test('the model cannot add an action, change a tier, or clear approval', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  // A draft response that tries to smuggle a plan into its output.
  const hostile = scripted(() => ({
    toolInput: {
      subject: 'Re: test',
      body: 'A perfectly ordinary reply.',
      actions: [{ type: 'send_email', payload: {} }],
      requiresApproval: false,
      riskTier: 0,
    },
    model: 'mock',
    latencyMs: 0,
    stopReason: 'tool_use',
  }));

  const baseline = await decideEmail(await emailFor(repos, 'demo-e05'), deps(repos));
  const attacked = await decideEmail(
    (await repos.emails.getById((await emailFor(repos, 'demo-e05')).id)) as EmailRecord,
    deps(repos, hostile),
  );

  assert.deepEqual(
    attacked.plan?.actions.map((a) => a.type),
    baseline.plan?.actions.map((a) => a.type),
    'extra fields in model output must not reach the plan',
  );
  assert.equal(attacked.plan?.riskTier, baseline.plan?.riskTier);
  await close();
});

test('DECIDE writes nothing to the CRM and sends nothing', async () => {
  // CONTRACT CHANGE (M6-E): this used to drive `handleDecidePending`, which now
  // runs any plan needing no approval — so the handler DOES act, deliberately.
  //
  // The invariant being protected was never about the handler. It is that the
  // DECIDE *stage* only plans: it must not be able to touch the CRM, queue a
  // reply or record an execution, whatever the caller does afterwards. So the
  // test now drives `decideEmail` directly, which is the thing the claim is
  // about, and the handler's new behaviour is asserted in `m6e.polish.test.ts`.
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const before = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
    notes: await repos.notes.count(),
  };

  const pending = await repos.emails.list({ state: 'deciding', limit: 100 });
  assert.ok(pending.length > 0, 'nothing was ready to decide, so nothing is proven');
  for (const email of pending) {
    await decideEmail(email, deps(repos));
  }

  assert.deepEqual(
    {
      contacts: await repos.contacts.count(),
      companies: await repos.companies.count(),
      deals: await repos.deals.count(),
      tasks: await repos.tasks.count(),
      activities: await repos.activities.count(),
      notes: await repos.notes.count(),
    },
    before,
    'DECIDE plans; it does not act',
  );

  const outbox = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_messages');
  const executions = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM action_executions');
  assert.equal(Number(outbox[0]?.n), 0);
  assert.equal(Number(executions[0]?.n), 0);
  await close();
});

// ==================================================== persistence (18, 19)

test('a decision persists the plan, policy result, draft and their sources separately', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const email = await emailFor(repos, 'demo-e01');
  await decideEmail(email, deps(repos));

  const stored = await repos.decisions.getCurrentForEmail(email.id);
  assert.ok(stored);
  assert.ok(stored.analysisId, 'the reading it was based on');
  assert.ok(stored.resolutionRun, 'the CRM match it was based on');
  assert.equal(stored.plan.actions.length, 6);
  assert.ok(stored.plan.ruleTrace.length > 5);
  assert.ok(stored.plan.approvalReasons.length > 0);
  assert.ok(stored.plan.draft?.guardrailsPassed.length);
  assert.equal(stored.promptVersion, 'draft.v1');
  assert.equal(stored.supersededBy, null);
  await close();
});

test('19. re-deciding supersedes rather than rewrites', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const email = await emailFor(repos, 'demo-e01');
  const first = await decideEmail(email, deps(repos));
  const reread = (await repos.emails.getById(email.id)) as EmailRecord;
  const second = await decideEmail(reread, deps(repos));

  const all = await repos.decisions.listForEmail(email.id);
  assert.equal(all.length, 2, 'history is appended');

  const current = await repos.decisions.getCurrentForEmail(email.id);
  assert.equal(current?.id, second.decision?.id);
  const superseded = all.find((d) => d.id === first.decision?.id);
  assert.equal(superseded?.supersededBy, second.decision?.id);

  // Deterministic: the same inputs produce the same plan.
  assert.deepEqual(
    second.plan?.actions.map((a) => a.type),
    first.plan?.actions.map((a) => a.type),
  );
  assert.equal(second.plan?.requiresApproval, first.plan?.requiresApproval);
  await close();
});

test('deciding an email that was never analysed is refused', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});

  const email = await emailFor(repos, 'demo-e01');
  await repos.emails.setState(email.id, 'deciding');
  const staged = (await repos.emails.getById(email.id)) as EmailRecord;
  const err = await rejects(() => decideEmail(staged, d));
  assert.match(err.message, /not been analysed/);
  await close();
});

// ================================================================ audit (22)

test('22. the full chain is traceable from ingestion to decision', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);

  const email = await emailFor(repos, 'demo-e01');
  await decideEmail(email, deps(repos));

  const events = await repos.audit.listByEmail(email.id);
  const types: string[] = events.map((e) => e.eventType);

  for (const expected of [
    'email_received', 'classification_recorded', 'extraction_recorded',
    'match_evaluated', 'plan_created', 'draft_generated', 'policy_evaluated',
    'approval_requested', 'state_changed',
  ]) {
    assert.ok(types.includes(expected), `missing audit event: ${expected}`);
  }

  const policy = events.find((e) => e.eventType === 'policy_evaluated');
  assert.ok(policy);
  assert.equal(policy.outcome, 'blocked');
  assert.ok((policy.payload.reasons as string[]).length > 0);

  // The email body is never copied into the audit trail.
  assert.doesNotMatch(JSON.stringify(events), /We run a small Shopify store/);
  await close();
});

// ================================================================ API (21)

test('21. the decide endpoints run the stage and expose the plan', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');
  const d = deps(repos);

  const batch = await handleDecidePending(d, {});
  assert.equal(batch.body.failed, 0);
  assert.ok(batch.body.decided >= 6);
  assert.ok(batch.body.awaitingApproval >= 1);

  const email = await emailFor(repos, 'demo-e01');
  const detail = await handleGetEmail(d, email.id);

  assert.equal(detail.body.stages.decide, 'complete');
  // CONTRACT CHANGE (M4-A): EXECUTE exists now. A plan needing approval waits.
  assert.equal(detail.body.stages.execute, 'awaiting_approval');
  assert.ok(detail.body.decision);
  assert.equal(detail.body.decision.plan.requiresApproval, true);
  assert.ok(detail.body.decision.plan.rationale.length > 40);
  await close();
});

test('the list view carries the decision summary, and null before one exists', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);
  const d = deps(repos);

  const before = await handleListEmails(d, {});
  assert.ok(before.body.emails.every((e) => e.decision === null), 'never a fabricated recommendation');

  await handleDecidePending(d, {});
  const after = await handleListEmails(d, {});
  const hero = after.body.emails.find((e) => e.subject.includes('Shopify'));
  assert.equal(hero?.decision?.requiresApproval, true);
  assert.equal(hero?.decision?.riskTier, 2);
  await close();
});

test('deciding an email in the wrong state, or one that does not exist, is refused', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos);
  const d = deps(repos);

  const notFound = await rejects(() => handleDecideEmail(d, 'no-such-id'));
  assert.equal((notFound as { code?: string }).code, 'NOT_FOUND');

  const held = await emailFor(repos, 'demo-e08');
  const wrongState = await rejects(() => handleDecideEmail(d, held.id));
  assert.equal((wrongState as { code?: string }).code, 'INVALID_STATE');
  await close();
});

// ========================================================== evaluation

test('the M3 evaluation passes every threshold, deterministically', async () => {
  const options = {
    datasetPath: path.join(MIGRATIONS_DIR, '..', 'eval', 'decide.dataset.json'),
    demoDataDir: DEMO_DATA_DIR,
    migrationsDir: MIGRATIONS_DIR,
  };

  const first = await runDecideEvaluation(options);
  assert.equal(first.metrics.passed, first.metrics.cases);
  assert.deepEqual(decideThresholdFailures(first.metrics), []);
  assert.equal(first.metrics.unsafeActionRate, 0);
  assert.equal(first.metrics.unsupportedClaimRate, 0);
  assert.equal(first.metrics.crmWrites, 0);

  const second = await runDecideEvaluation(options);
  assert.deepEqual(second.metrics, first.metrics, 'same inputs must give the same numbers');
});
