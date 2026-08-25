import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, startAuthenticatedServer, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import {
  handleDecideEmail,
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M6-E — the demo polish pass, server side.
//
// Two fixes are tested here. The second is the only behavioural change in the
// whole pass, so it carries the weight.
//
// FIX 2 — health reported the process, not the app.
// FIX 6 — a plan that needs no approval never ran.
//
// On fix 6: `nextState` leaves an unattended plan in `deciding` and the comment
// beside it says why — M3 could not execute, so moving the email to `executing`
// would have claimed something was happening when nothing was. It ends "M4
// makes that transition when it can honour it." M4 shipped the executor and
// nothing came back for this, so every tier-0 plan since has been decided and
// then abandoned: not in the approval queue, because it needs no approval, and
// not executed, because nobody asked. §8 is explicit that `deciding →
// executing` is legal for a zero-risk plan, and §16 defines `assisted` as
// "tier 0 auto-executes at high confidence". This restores that.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-09-01T00:00:00.000Z', 1000);

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

/** Seeds, ingests, understands and resolves — everything up to DECIDE. */
async function pipelineToDecide(repos: Repositories, autonomy: 'manual' | 'assisted'): Promise<void> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  await repos.settings.set('autonomy_level', autonomy, 'test');
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

async function stateOf(repos: Repositories, id: string): Promise<string> {
  const email = await repos.emails.getById(id);
  assert.ok(email);
  return email.state;
}

// ============================================================ fix 2 — health

test('health reports the config of the app it is mounted on', async () => {
  const { db, close } = await createTestContext();
  // This helper builds the app with an operator password hash set, so sign-in
  // works — which is exactly what health used to deny.
  const server = await startAuthenticatedServer(db);

  try {
    const response = await fetch(`${server.url}/api/health`, { headers: { cookie: server.cookie } });
    const body = (await response.json()) as { adapters: Record<string, unknown>; version: string };

    // The regression: this read `false` while the caller was holding a live
    // session issued by the very app being reported on.
    assert.equal(body.adapters.authConfigured, true, 'health denies an auth that demonstrably works');
    assert.equal(body.version, '1.0.0');
  } finally {
    await server.stop();
    await close();
  }
});

test('the health wiring test is not vacuous', async () => {
  // Negative control. If `handleHealth` silently fell back to the process
  // default again, the assertion above must fail rather than pass by accident —
  // so prove the default really does say `false` in this process.
  const { configSummary, config: processConfig } = await import('../src/config/env.ts');

  assert.equal(
    processConfig.operatorPasswordHash,
    null,
    'the test process has an operator hash set, so the assertion above proves nothing',
  );
  assert.equal(configSummary(processConfig).authConfigured, false);
});

// ================================================ fix 6 — the unattended path

test('a plan that needs no approval runs, and the email reaches a terminal state', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  // demo-e05 is the support request: log an activity and open a follow-up.
  // Both are tier 0, so `assisted` autonomy needs no human.
  const email = await emailFor(repos, 'demo-e05');
  const { body } = await handleDecideEmail(deps(repos), email.id);

  const decision = body.decision;
  assert.ok(decision, 'no plan was produced');
  // PRECONDITION. If this email ever stops being an unattended tier-0 plan the
  // test below would pass for the wrong reason, so it fails loudly instead.
  assert.equal(decision.plan.riskTier, 0, 'demo-e05 is no longer a tier-0 plan');
  assert.equal(decision.plan.requiresApproval, false, 'demo-e05 now requires approval');

  // The whole point: it is finished, not parked in `deciding`.
  assert.equal(body.email.state, 'completed');
  assert.notEqual(body.email.state, 'deciding');

  // And it actually did the work, rather than just moving a status column.
  const executions = body.executions.filter((execution) => execution.status === 'succeeded');
  assert.ok(executions.length > 0, 'the email completed without executing anything');

  await close();
});

test('an unattended plan writes real CRM records', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const before = (await repos.tasks.list({ limit: 100 })).length;
  const email = await emailFor(repos, 'demo-e05');
  await handleDecideEmail(deps(repos), email.id);
  const after = await repos.tasks.list({ limit: 100 });

  assert.ok(after.length > before, 'no follow-up was created');
  // Created by the executor, so it carries the agent source the CRM screens
  // badge — not `seed`, which would mean it came from the fixture.
  assert.ok(
    after.some((task) => task.source === 'agent'),
    'the follow-up is not attributed to the assistant',
  );

  await close();
});

test('a spam plan archives rather than completing', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  // demo-e09 is the cold outreach: one tier-0 `archive_email`.
  const email = await emailFor(repos, 'demo-e09');
  const { body } = await handleDecideEmail(deps(repos), email.id);

  assert.equal(body.decision?.plan.riskTier, 0);
  assert.equal(body.email.state, 'archived');

  await close();
});

test('the batch path runs unattended plans and reports how many', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const { body } = await handleDecidePending(deps(repos), {});

  assert.ok(body.decided > 0);
  // A zero here would make every assertion below vacuous.
  assert.ok(body.autoExecuted > 0, 'the batch decided plans but ran none of them');
  assert.ok(body.awaitingApproval > 0, 'nothing was left for a person, which is not this fixture set');

  // Nothing may be left sitting in `deciding` — that was the finding.
  const stranded = await repos.emails.list({ state: 'deciding', limit: 100 });
  assert.deepEqual(
    stranded.map((email) => email.subject),
    [],
    'emails were decided and then abandoned in `deciding`',
  );

  await close();
});

test('the summaries the batch returns say where the email actually ended up', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const { body } = await handleDecidePending(deps(repos), {});

  // The batch re-reads each email after running it. Without that it would
  // report the state DECIDE left behind, and the Inbox would show `deciding`
  // for an email that had already finished.
  for (const summary of body.results) {
    assert.equal(summary.state, await stateOf(repos, summary.id), `${summary.subject} reports a stale state`);
  }
  assert.ok(body.results.some((summary) => summary.state === 'completed' || summary.state === 'archived'));

  await close();
});

// ------------------------------------------------- the boundary is untouched

test('manual autonomy still sends every plan to a person', async () => {
  const { repos, close } = await createTestContext();
  // The negative control for the whole fix. Same email, same code path, one
  // setting different — and nothing may run.
  await pipelineToDecide(repos, 'manual');

  const email = await emailFor(repos, 'demo-e05');
  const { body } = await handleDecideEmail(deps(repos), email.id);

  assert.equal(body.decision?.plan.requiresApproval, true, 'manual autonomy did not require approval');
  assert.equal(body.email.state, 'awaiting_approval');
  assert.equal(body.executions.length, 0, 'a plan ran without a human under manual autonomy');

  await close();
});

test('a plan that requires approval is never run by the unattended path', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  // demo-e01 is the sales enquiry — it opens a deal and sends a reply, so it
  // carries a tier-2 action and can never run unattended at any autonomy level.
  const email = await emailFor(repos, 'demo-e01');
  const { body } = await handleDecideEmail(deps(repos), email.id);

  assert.ok(body.decision);
  assert.ok(body.decision.plan.riskTier >= 1, 'demo-e01 is no longer a consequential plan');
  assert.equal(body.decision.plan.requiresApproval, true);
  assert.equal(body.email.state, 'awaiting_approval');
  assert.equal(body.executions.length, 0, 'a plan requiring approval was executed');

  await close();
});

test('no autonomy level lets a tier-2 action run unattended', async () => {
  // The product guarantee from §16, asserted against the path this pass added
  // rather than against the policy function alone.
  for (const autonomy of ['manual', 'assisted', 'autonomous_low_risk'] as const) {
    const { repos, close } = await createTestContext();
    await pipelineToDecide(repos, autonomy as 'manual' | 'assisted');

    const email = await emailFor(repos, 'demo-e01');
    const { body } = await handleDecideEmail(deps(repos), email.id);

    const tier = body.decision?.plan.riskTier ?? 0;
    if (tier >= 2) {
      assert.equal(body.executions.length, 0, `a tier-2 plan ran unattended under ${autonomy}`);
      assert.equal(body.email.state, 'awaiting_approval');
    }

    await close();
  }
});

test('the injection email is still quarantined and never runs', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  // demo-e10 tries to give the agent orders. UNDERSTAND routes it to a person
  // before DECIDE ever sees it, so the unattended path must not touch it.
  const email = await emailFor(repos, 'demo-e10');

  assert.equal(email.state, 'needs_review');
  assert.equal(email.reviewReason, 'possible_injection');

  const decisions = await repos.decisions.listForEmail(email.id);
  assert.deepEqual(decisions, [], 'a plan was made for a quarantined email');

  await close();
});

test('the unattended path can never deliver a reply', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToDecide(repos, 'assisted');

  const { body } = await handleDecidePending(deps(repos), {});

  // PRECONDITION: plans actually ran unattended, or this proves nothing.
  assert.ok(body.autoExecuted > 0, 'nothing ran unattended, so nothing was proven');

  // Nothing was delivered.
  assert.deepEqual(await repos.outbox.listByStatus('sent', 100), [], 'a reply was delivered');

  // And the structural reason, which is the part worth asserting: `send_email`
  // is tier 2, tier 2 always requires approval at every autonomy level, and the
  // unattended path only runs plans that require none. So a reply cannot reach
  // the outbox by this route at all — not "is currently suppressed", but
  // "cannot be queued". Check that directly rather than trusting the outcome.
  const ran = body.results.filter((summary) => summary.state === 'completed' || summary.state === 'archived');
  assert.ok(ran.length > 0);

  for (const summary of ran) {
    const decision = await repos.decisions.getCurrentForEmail(summary.id);
    assert.ok(decision, `${summary.subject} completed with no decision`);
    assert.equal(decision.plan.requiresApproval, false);
    assert.ok(
      !decision.plan.actions.some((action) => action.type === 'send_email'),
      `${summary.subject} sent a reply without approval`,
    );
  }

  await close();
});
