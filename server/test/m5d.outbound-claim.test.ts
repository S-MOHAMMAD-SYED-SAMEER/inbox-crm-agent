import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, DEMO_DATA_DIR, MIGRATION_COUNT } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createMockOutboundSender, type MockOutboundSender } from '../src/adapters/outbound/index.ts';
import { reviseDecision } from '../src/agent/revise/revise.ts';
import { sweepExpiredApprovals } from '../src/agent/approve/expiry.ts';
import { executePlan } from '../src/agent/execute/executor.ts';
import { planFingerprint, OUTBOX_STATUSES } from '../src/domain/execution.ts';
import { appliedMigrations } from '../src/db/migrate.ts';
import {
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { Database } from '../src/db/types.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M5-D — the outbound sending claim. Audit finding F-05.
//
// The audit found that concurrent delivery produced exactly one email — but for
// the wrong reason. The second attempt collided on the audit sequence constraint
// before it happened to reach the provider. Reorder the audit append and
// duplicate customer email appears, silently.
//
// This file makes the guarantee explicit and then attacks it: two executors race
// one message, and the database decides.
//
// WHICH TEST ACTUALLY PROVES THE CLAIM — AND WHICH DOES NOT
//
// A negative control was run: the claim's `status IN ('queued','failed')`
// condition was removed and the suite re-run. The repository-level claim tests
// failed, as they must. The end-to-end executor test below did NOT — because the
// audit sequence constraint still serialises the second attempt before it
// reaches the provider, which is the very incidental protection F-05 was raised
// about.
//
// So the honest reading is recorded here rather than glossed: *the
// repository-level claim tests are the regression tests for this fix*. The
// end-to-end test documents the behaviour a caller sees; it is not sensitive to
// the claim, because a second, unrelated protection sits in front of it. If the
// audit sequencing were ever made lock-free, that test would go quiet and only
// the claim tests would still be watching.

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

type Fixture = {
  db: Database;
  repos: Repositories;
  email: EmailRecord;
  decision: DecisionRecord;
  close(): Promise<void>;
};

/** demo-e01 approved and ready to deliver. */
async function approved(): Promise<Fixture> {
  const ctx = await createTestContext({ idPrefix: 'm5d' });
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
  await ctx.repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

  return { db: ctx.db, repos: ctx.repos, email, decision, close: ctx.close };
}

async function run(f: Fixture, decision: DecisionRecord, sender: MockOutboundSender) {
  await f.repos.emails.setState(f.email.id, 'awaiting_approval');
  return executePlan((await f.repos.emails.getById(f.email.id)) as EmailRecord, decision, {
    repos: f.repos,
    clock,
    logger: quiet,
    sender,
  });
}

// --- migration ---------------------------------------------------------------

test('migration 010 adds sending and preserves the outbox contract', async () => {
  const { db, repos, close } = await createTestContext();
  const applied = await appliedMigrations(db);

  assert.equal(applied.length, MIGRATION_COUNT);
  assert.ok(applied.some((migration) => migration.name === '010_outbox_sending.sql'));
  assert.deepEqual([...OUTBOX_STATUSES], ['queued', 'sending', 'sent', 'suppressed', 'failed']);

  // The rebuild kept the key, the foreign keys and the CHECK.
  const sql = (await db.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'outbox_messages'"))[0];
  assert.match(sql?.sql ?? '', /'sending'/);
  assert.match(sql?.sql ?? '', /REFERENCES decisions/);
  assert.match(sql?.sql ?? '', /claimed_at/);

  await assert.rejects(
    () =>
      db.execute(
        'INSERT INTO outbox_messages (id, email_id, decision_id, to_email, subject, body, status, created_at) ' +
          "VALUES ('x','no-email','no-decision','a@b.co','s','b','bogus','2026-06-01T00:00:00.000Z')",
      ),
    'the rebuilt table accepts an invalid status or a dangling reference',
  );

  assert.equal(await repos.outbox.count(), 0);
  await close();
});

// --- the claim ---------------------------------------------------------------

test('only one of two concurrent claims succeeds', async () => {
  const f = await approved();
  const created = await f.repos.outbox.create({
    emailId: f.email.id,
    decisionId: f.decision.id,
    toEmail: 'sarah@acmecommerce.io',
    subject: 's',
    body: 'b',
    status: 'queued',
    suppressedReason: null,
  });

  const [a, b] = await Promise.all([
    f.repos.outbox.claimForSending(created.id),
    f.repos.outbox.claimForSending(created.id),
  ]);

  const winners = [a, b].filter((claim) => claim !== null);
  assert.equal(winners.length, 1, 'two callers both claimed the same message');
  assert.equal(winners[0]?.status, 'sending');
  assert.ok(winners[0]?.claimedAt, 'a claim recorded no time, so staleness is unknowable');

  // And a third caller cannot take it while it is held.
  assert.equal(await f.repos.outbox.claimForSending(created.id), null);

  await f.close();
});

test('a sent or suppressed message can never be claimed', async () => {
  const f = await approved();

  for (const status of ['sent', 'suppressed'] as const) {
    const row = await f.repos.outbox.create({
      emailId: f.email.id,
      decisionId: f.decision.id,
      toEmail: 'sarah@acmecommerce.io',
      subject: 's',
      body: 'b',
      status,
      suppressedReason: null,
    });
    assert.equal(await f.repos.outbox.claimForSending(row.id), null, `a ${status} message was claimed`);
  }

  await f.close();
});

test('a failed message can be claimed again, which is what makes retry possible', async () => {
  const f = await approved();
  const row = await f.repos.outbox.create({
    emailId: f.email.id,
    decisionId: f.decision.id,
    toEmail: 'sarah@acmecommerce.io',
    subject: 's',
    body: 'b',
    status: 'failed',
    suppressedReason: 'temporary',
  });

  const claimed = await f.repos.outbox.claimForSending(row.id);
  assert.equal(claimed?.status, 'sending');
  assert.equal(claimed?.suppressedReason, null, 'the previous failure reason survived the reclaim');

  await f.close();
});

// --- the delivery flow -------------------------------------------------------

test('a delivery moves queued through sending to sent', async () => {
  const f = await approved();
  const sender = createMockOutboundSender();

  const outcome = await run(f, f.decision, sender);
  assert.equal(outcome.ok, true);
  assert.equal(sender.sent.length, 1);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.ok(outbox?.sentAt);
  assert.equal(outbox?.claimedAt, null, 'a delivered message still holds its claim');

  // The audit records the claim and the outcome, in order.
  const events = (await f.repos.audit.listByEmail(f.email.id))
    .filter((event) => event.eventType.startsWith('outbound_send_'))
    .map((event) => event.eventType);
  assert.deepEqual(events, ['outbound_send_attempted', 'outbound_send_succeeded']);

  await f.close();
});

test('a provider failure after the claim lands in failed, never sent', async () => {
  const f = await approved();
  const sender = createMockOutboundSender({ behaviour: 'permanent_failure' });

  await run(f, f.decision, sender);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'failed');
  assert.equal(outbox?.sentAt, null);
  assert.equal(outbox?.claimedAt, null, 'a failed attempt kept its claim and blocked every retry');
  assert.equal(sender.sent.length, 0);

  await f.close();
});

test('a failed delivery retries and succeeds, sending exactly once in total', async () => {
  const f = await approved();
  const sender = createMockOutboundSender({ behaviour: 'unavailable' });

  await run(f, f.decision, sender);
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'failed');

  sender.behaviour = 'success';
  await run(f, f.decision, sender);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.equal(sender.sent.length, 1, 'the retry delivered more than once');
  assert.equal(await f.repos.outbox.count(), 1, 'the retry created a second outbox row');

  await f.close();
});

test('an already-sent message is never sent again', async () => {
  const f = await approved();
  const sender = createMockOutboundSender();

  for (let attempt = 0; attempt < 3; attempt++) await run(f, f.decision, sender);

  assert.equal(sender.sent.length, 1, 'a delivered reply went out more than once');
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'sent');

  await f.close();
});

test('a suppressed message is never claimed or sent', async () => {
  const f = await approved();
  const disabled = createMockOutboundSender({ enabled: false });

  await run(f, f.decision, disabled);
  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'suppressed');
  assert.equal(outbox?.claimedAt, null);

  // Even with a live sender afterwards, a suppressed row stays put.
  const live = createMockOutboundSender();
  await run(f, f.decision, live);
  assert.equal(live.calls.length, 0, 'a suppressed message reached the provider');
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'suppressed');

  await f.close();
});

// --- stale claim recovery ----------------------------------------------------

test('a stale claim is recovered to failed by an explicit deterministic rule', async () => {
  const f = await approved();
  const row = await f.repos.outbox.create({
    emailId: f.email.id,
    decisionId: f.decision.id,
    toEmail: 'sarah@acmecommerce.io',
    subject: 's',
    body: 'b',
    status: 'queued',
    suppressedReason: null,
  });
  const claimed = await f.repos.outbox.claimForSending(row.id);
  assert.equal(claimed?.status, 'sending');

  // Not yet stale — recovery must not steal a claim that is still working.
  const tooSoon = await f.repos.outbox.recoverStaleSending(15 * 60_000, '2026-06-01T00:05:00.000Z');
  assert.deepEqual(tooSoon, []);
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'sending');

  // Past the timeout, it is recovered — to `failed`, never to `sent`: whether
  // the provider delivered before the crash is unknowable from here.
  const recovered = await f.repos.outbox.recoverStaleSending(15 * 60_000, '2026-06-01T01:00:00.000Z');
  assert.equal(recovered.length, 1);

  const after = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(after?.status, 'failed');
  assert.equal(after?.suppressedReason, 'sending_timed_out');
  assert.equal(after?.claimedAt, null);
  assert.equal(after?.sentAt, null);

  await f.close();
});

test('recovery only ever touches rows that are sending', async () => {
  const f = await approved();

  for (const status of ['sent', 'suppressed', 'queued', 'failed'] as const) {
    await f.db.execute('DELETE FROM outbox_messages');
    await f.repos.outbox.create({
      emailId: f.email.id,
      decisionId: f.decision.id,
      toEmail: 'sarah@acmecommerce.io',
      subject: 's',
      body: 'b',
      status,
      suppressedReason: null,
    });

    // A timeout of zero and a far-future clock: everything is "old". Only the
    // status should stop recovery from taking it.
    const recovered = await f.repos.outbox.recoverStaleSending(0, '2099-01-01T00:00:00.000Z');
    assert.deepEqual(recovered, [], `recovery moved a ${status} row`);
    assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, status);
  }

  await f.close();
});

// --- the property the whole milestone exists for -----------------------------

test('two concurrent executions of one approved plan deliver exactly one email', async () => {
  // Attacked at the executor, not through the UI.
  //
  // NOTE: this test also passes without the claim, because the audit sequence
  // constraint serialises the losing attempt first. It documents the behaviour
  // a caller sees; the claim tests above are what actually guard the fix. See
  // the header comment for the negative control that established this.
  const f = await approved();
  const sender = createMockOutboundSender();

  await f.repos.emails.setState(f.email.id, 'awaiting_approval');
  const email = (await f.repos.emails.getById(f.email.id)) as EmailRecord;

  const settled = await Promise.allSettled([
    executePlan(email, f.decision, { repos: f.repos, clock, logger: quiet, sender }),
    executePlan(email, f.decision, { repos: f.repos, clock, logger: quiet, sender }),
  ]);

  assert.ok(
    settled.some((result) => result.status === 'fulfilled'),
    'neither attempt completed',
  );
  assert.equal(sender.calls.length, 1, `the provider was called ${sender.calls.length} times`);
  assert.equal(sender.sent.length, 1, 'the customer received more than one copy');

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.equal(await f.repos.outbox.count(), 1, 'a second outbox row was created');

  await f.close();
});

test('a recovered message can be retried and then delivers', async () => {
  const f = await approved();
  const row = await f.repos.outbox.create({
    emailId: f.email.id,
    decisionId: f.decision.id,
    toEmail: 'sarah@acmecommerce.io',
    subject: f.decision.plan.draft?.subject as string,
    body: f.decision.plan.draft?.body as string,
    status: 'queued',
    suppressedReason: null,
  });
  await f.repos.outbox.claimForSending(row.id);
  await f.repos.outbox.recoverStaleSending(0, '2099-01-01T00:00:00.000Z');

  const sender = createMockOutboundSender();
  await run(f, f.decision, sender);

  assert.equal(sender.sent.length, 1);
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'sent');

  await f.close();
});

// --- every existing guarantee still holds ------------------------------------

test('the claim does not weaken approval, fingerprint, expiry or supersession', async () => {
  // Unapproved.
  {
    const ctx = await createTestContext({ idPrefix: 'guard-unapproved' });
    await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));
    await ctx.repos.settings.set('autonomy_level', 'manual', 'test');
    const d = deps(ctx.repos);
    await ingestEmails(d, {});
    await handleUnderstandPending(d, {});
    await handleResolvePending(d, {});
    await handleDecidePending(d, {});

    const email = (await ctx.repos.emails.list({ limit: 50 })).find(
      (row) => row.providerMessageId === 'demo-e01',
    ) as EmailRecord;
    const decision = (await ctx.repos.decisions.getCurrentForEmail(email.id)) as DecisionRecord;

    const sender = createMockOutboundSender();
    const outcome = await executePlan(email, decision, { repos: ctx.repos, clock, logger: quiet, sender });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusedWith, 'approval_not_granted');
    assert.equal(sender.calls.length, 0, 'an unapproved reply reached the provider');
    assert.equal(await ctx.repos.outbox.count(), 0);
    await ctx.close();
  }

  // Fingerprint mismatch.
  {
    const f = await approved();
    await f.db.execute('UPDATE decisions SET draft_body = ? WHERE id = ?', ['tampered', f.decision.id]);
    const tampered = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;

    const sender = createMockOutboundSender();
    const outcome = await run(f, tampered, sender);
    assert.equal(outcome.refusedWith, 'plan_changed_since_approval');
    assert.equal(sender.calls.length, 0);
    await f.close();
  }

  // Expired.
  {
    const f = await approved();
    await f.db.execute('UPDATE approvals SET state = ?, expires_at = ? WHERE decision_id = ?', [
      'pending',
      '2020-01-01T00:00:00.000Z',
      f.decision.id,
    ]);
    await sweepExpiredApprovals({ repos: f.repos, clock, logger: quiet, limit: 10 });

    const sender = createMockOutboundSender();
    const outcome = await run(f, f.decision, sender);
    assert.equal(outcome.ok, false);
    assert.equal(sender.calls.length, 0, 'an expired approval reached the provider');
    await f.close();
  }

  // Superseded.
  {
    const f = await approved();
    await f.db.execute('UPDATE approvals SET state = ? WHERE decision_id = ?', ['pending', f.decision.id]);
    await reviseDecision(
      f.decision.id,
      { edits: { draft: { subject: 'A calmer subject' } }, editedBy: 'sameer' },
      { repos: f.repos, clock, logger: quiet },
    );
    const stale = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;

    const sender = createMockOutboundSender();
    const outcome = await run(f, stale, sender);
    assert.equal(outcome.refusedWith, 'decision_superseded');
    assert.equal(sender.calls.length, 0);
    await f.close();
  }
});

test('a disabled provider is never claimed against', async () => {
  const f = await approved();
  const disabled = createMockOutboundSender({ enabled: false });

  await run(f, f.decision, disabled);

  assert.equal(disabled.calls.length, 0);
  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'suppressed');
  assert.equal(outbox?.claimedAt, null, 'a suppressed message was claimed');

  await f.close();
});
