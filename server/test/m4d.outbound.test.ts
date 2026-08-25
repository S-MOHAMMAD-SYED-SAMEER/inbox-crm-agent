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
import { loadConfig } from '../src/config/env.ts';
import {
  createMockOutboundSender,
  createDisabledOutboundSender,
  createOutboundSender,
  type MockOutboundSender,
} from '../src/adapters/outbound/index.ts';
import { outboundSendingPossible, isRetryable } from '../src/domain/outbound.ts';
import { reviseDecision } from '../src/agent/revise/revise.ts';
import { sweepExpiredApprovals } from '../src/agent/approve/expiry.ts';
import { executePlan } from '../src/agent/execute/executor.ts';
import { planFingerprint } from '../src/domain/execution.ts';
import {
  handleApprove,
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { Database } from '../src/db/types.ts';
import type { DecisionRecord } from '../src/domain/decision.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M4-D — the outbound email adapter.
//
// This is the first capability in the system that can put text in front of a
// customer, so the tests below are mostly about the circumstances in which it
// must NOT do that.
//
// The shape of the guarantee: outbound delivery is the LAST step of execution
// and never a second entrance to it. Everything that decides whether a reply
// may exist — the approval, the plan fingerprint, the draft guardrails, whether
// the decision is still current — was settled before the sender is consulted.
// Turning sending on does not soften any of it; it only changes what happens
// after all of it has passed.
//
// NO TEST HERE MAKES A NETWORK CALL. The mock provider is a local object, and
// one of the tests below proves the default configuration cannot reach a
// provider at all.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-06-01T02:00:00.000Z', 1000);

function deps(repos: Repositories, sender?: MockOutboundSender) {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider,
    logger: quiet,
    clock,
    ...(sender ? { sender } : {}),
  };
}

type Fixture = {
  db: Database;
  repos: Repositories;
  email: EmailRecord;
  decision: DecisionRecord;
  sender: MockOutboundSender;
  close(): Promise<void>;
};

/** demo-e01: the hero lead — tier 2, a drafted reply, and a send_email action. */
async function pending(): Promise<Fixture> {
  const ctx = await createTestContext({ idPrefix: 'm4d' });
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
  assert.ok(decision.plan.actions.some((action) => action.type === 'send_email'));
  assert.ok(decision.plan.draft);

  return {
    db: ctx.db,
    repos: ctx.repos,
    email,
    decision,
    sender: createMockOutboundSender(),
    close: ctx.close,
  };
}

const approve = (repos: Repositories, decision: DecisionRecord) =>
  repos.approvals.decide(decision.id, 'approved', {
    decidedBy: 'sameer',
    planHash: planFingerprint(decision.plan),
  });

async function runPlan(f: Fixture, decision: DecisionRecord, sender = f.sender) {
  await f.repos.emails.setState(f.email.id, 'awaiting_approval');
  return executePlan((await f.repos.emails.getById(f.email.id)) as EmailRecord, decision, {
    repos: f.repos,
    clock,
    logger: quiet,
    sender,
  });
}

// --- 1, 17  the default: disabled -------------------------------------------

test('the default configuration cannot send, and never reaches a provider', () => {
  const { config } = loadConfig({});
  assert.equal(config.allowOutboundSend, false);
  assert.equal(config.outboundProvider, 'none');
  assert.equal(outboundSendingPossible(config.allowOutboundSend, config.outboundProvider), false);

  const sender = createOutboundSender(config);
  assert.equal(sender.enabled, false);
  assert.equal(sender.name, 'none');
});

test('with outbound disabled an approved reply is suppressed, and no provider is called', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  // A sender that records every call, wired to a *disabled* executor path.
  const spy = createMockOutboundSender({ enabled: false });
  const outcome = await runPlan(f, f.decision, spy);

  assert.equal(outcome.ok, true);
  assert.equal(spy.calls.length, 0, 'a provider was called while sending was disabled');

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.ok(outbox);
  assert.equal(outbox.status, 'suppressed');
  assert.equal(outbox.suppressedReason, 'outbound_send_disabled');
  assert.equal(outbox.sentAt, null);
  assert.equal(outbox.providerMessageId, null);
  assert.equal((await f.repos.outbox.listByStatus('sent')).length, 0);

  await f.close();
});

test('the disabled sender refuses everything it is handed', async () => {
  const sender = createDisabledOutboundSender();
  const result = await sender.send(
    { toEmail: 'someone@example.com', subject: 's', body: 'b' },
    { emailId: 'e', decisionId: 'd', idempotencyKey: 'k' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, 'blocked');
});

// --- 2, 6, 7, 8  sending never softens any existing gate --------------------

test('with outbound enabled an unapproved plan still sends nothing', async () => {
  const f = await pending();
  // No approval granted. The plan is tier 2, so approval is required.
  const outcome = await runPlan(f, f.decision);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'approval_not_granted');
  assert.equal(f.sender.calls.length, 0, 'an unapproved reply reached the provider');
  assert.equal(await f.repos.outbox.count(), 0);
  assert.equal(await f.repos.companies.count(), 6, 'the CRM changed for an unapproved plan');

  await f.close();
});

test('a superseded plan sends nothing, even with outbound enabled', async () => {
  const f = await pending();
  await reviseDecision(
    f.decision.id,
    { edits: { draft: { subject: 'A calmer subject' } }, editedBy: 'sameer' },
    { repos: f.repos, clock, logger: quiet },
  );

  // Re-read: the revision superseded v1 in the database, and the refusal we
  // want to prove is the one the executor derives from the stored row.
  const v1 = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;
  const outcome = await runPlan(f, v1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'decision_superseded');
  assert.equal(f.sender.calls.length, 0);
  assert.equal(await f.repos.outbox.count(), 0);

  await f.close();
});

test('an expired approval sends nothing, even with outbound enabled', async () => {
  const f = await pending();
  await f.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
    '2020-01-01T00:00:00.000Z',
    f.decision.id,
  ]);
  await sweepExpiredApprovals({ repos: f.repos, clock, logger: quiet, limit: 10 });

  const outcome = await runPlan(f, f.decision);
  assert.equal(outcome.ok, false);
  assert.equal(f.sender.calls.length, 0);
  assert.equal(await f.repos.outbox.count(), 0);

  await f.close();
});

test('a plan whose draft was blocked sends nothing, even with outbound enabled', async () => {
  const f = await pending();
  // Mark the stored draft as having failed a content check, as M3 would.
  await f.db.execute('UPDATE decisions SET draft_blocked_by = ? WHERE id = ?', [
    JSON.stringify([{ guardrail: 'no_price_commitment', evidence: 'redacted', why: 'test' }]),
    f.decision.id,
  ]);
  const blocked = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;
  await approve(f.repos, blocked);

  const outcome = await runPlan(f, blocked);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'draft_blocked');
  assert.equal(f.sender.calls.length, 0, 'a guardrail-blocked reply reached the provider');
  assert.equal(await f.repos.outbox.count(), 0);

  await f.close();
});

test('a plan changed after approval sends nothing', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  // The approval was bound to the plan as it stood. Alter the stored draft.
  await f.db.execute('UPDATE decisions SET draft_body = ? WHERE id = ?', [
    'Hi Sarah,\n\nActually, here is something nobody approved.\n\nSameer',
    f.decision.id,
  ]);
  const tampered = (await f.repos.decisions.getById(f.decision.id)) as DecisionRecord;

  const outcome = await runPlan(f, tampered);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusedWith, 'plan_changed_since_approval');
  assert.equal(f.sender.calls.length, 0, 'a tampered reply reached the provider');

  await f.close();
});

// --- 3, 9  the approved path ------------------------------------------------

test('an approved reply is delivered exactly once, and the outbox records it', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  const outcome = await runPlan(f, f.decision);
  assert.equal(outcome.ok, true);

  assert.equal(f.sender.calls.length, 1, `expected one delivery, got ${f.sender.describe().join('; ')}`);
  assert.equal(f.sender.sent.length, 1);

  const delivered = f.sender.sent[0];
  assert.equal(delivered?.toEmail, f.email.fromEmail);
  assert.equal(delivered?.subject, f.decision.plan.draft?.subject);
  assert.equal(delivered?.body, f.decision.plan.draft?.body);
  assert.equal(delivered?.decisionId, f.decision.id);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.equal(outbox?.providerMessageId, delivered?.providerMessageId);
  assert.ok(outbox?.sentAt);
  assert.equal(outbox?.suppressedReason, null);

  await f.close();
});

// --- 5  a revision sends the revised text, never the original ---------------

test('after a revision the provider receives v2, and no part of v1', async () => {
  const f = await pending();
  const originalSubject = f.decision.plan.draft?.subject as string;
  const originalBody = f.decision.plan.draft?.body as string;

  const revised = await reviseDecision(
    f.decision.id,
    {
      edits: {
        draft: {
          subject: 'Thanks for getting in touch',
          body: 'Hi Sarah,\n\nHappy to help. When would suit you for a short call?\n\nSameer',
        },
      },
      editedBy: 'sameer',
    },
    { repos: f.repos, clock, logger: quiet },
  );

  await approve(f.repos, revised.decision);
  const outcome = await runPlan(f, revised.decision);
  assert.equal(outcome.ok, true);

  assert.equal(f.sender.sent.length, 1);
  const delivered = f.sender.sent[0];
  assert.equal(delivered?.subject, 'Thanks for getting in touch');
  assert.match(delivered?.body ?? '', /Happy to help/);
  assert.equal(delivered?.decisionId, revised.decision.id);
  assert.equal(delivered?.toEmail, f.email.fromEmail);

  // Not one word of the superseded draft went out.
  assert.notEqual(delivered?.subject, originalSubject);
  assert.notEqual(delivered?.body, originalBody);

  const outbox = await f.repos.outbox.findForDecision(revised.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.equal(outbox?.subject, 'Thanks for getting in touch');

  await f.close();
});

// --- 10, 11  failures -------------------------------------------------------

test('every provider failure is recorded as failed, never as sent', async () => {
  for (const [behaviour, kind] of [
    ['temporary_failure', 'temporary'],
    ['permanent_failure', 'permanent'],
    ['unavailable', 'unavailable'],
    ['timeout', 'timeout'],
  ] as const) {
    const f = await pending();
    await approve(f.repos, f.decision);

    const sender = createMockOutboundSender({ behaviour });
    const outcome = await runPlan(f, f.decision, sender);

    // The CRM work succeeded; only delivery failed. Rolling back five correct
    // records because a mail server was down would be the wrong trade.
    assert.equal(outcome.ok, true, `${behaviour} failed the whole execution`);
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.sent.length, 0);

    const outbox = await f.repos.outbox.findForDecision(f.decision.id);
    assert.equal(outbox?.status, 'failed', `${behaviour} did not mark the outbox failed`);
    assert.equal(outbox?.sentAt, null, `${behaviour} recorded a send time`);
    assert.equal(outbox?.providerMessageId, null);
    assert.equal(outbox?.suppressedReason, kind);
    assert.equal((await f.repos.outbox.listByStatus('sent')).length, 0);

    const failed = (await f.repos.audit.listByEmail(f.email.id)).find(
      (event) => event.eventType === 'outbound_send_failed',
    );
    assert.ok(failed, `${behaviour} was not audited`);
    assert.equal((failed.payload as { retryable?: boolean }).retryable, isRetryable(kind));

    await f.close();
  }
});

test('a provider that throws is a failure, never a delivery', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  const exploding = createMockOutboundSender();
  exploding.send = async () => {
    throw new Error('socket hang up');
  };

  const outcome = await runPlan(f, f.decision, exploding);
  assert.equal(outcome.ok, true);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'failed');
  assert.equal(outbox?.sentAt, null);

  await f.close();
});

test('a failed delivery can be retried, and a successful one cannot be re-sent', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  const flaky = createMockOutboundSender({ behaviour: 'temporary_failure' });
  await runPlan(f, f.decision, flaky);
  assert.equal((await f.repos.outbox.findForDecision(f.decision.id))?.status, 'failed');

  // The operator retries once the provider is healthy.
  flaky.behaviour = 'success';
  await runPlan(f, f.decision, flaky);

  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'sent');
  assert.equal(flaky.sent.length, 1);
  assert.equal(await f.repos.outbox.count(), 1, 'the retry created a second outbox row');

  // Running again now that it succeeded must not send a second copy.
  await runPlan(f, f.decision, flaky);
  await runPlan(f, f.decision, flaky);
  assert.equal(flaky.sent.length, 1, 'a delivered reply was sent again');
  assert.equal(flaky.calls.length, 2, 'the provider was consulted after a successful delivery');

  await f.close();
});

// --- 12  idempotency --------------------------------------------------------

test('executing an approved plan repeatedly delivers exactly one message', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  for (let attempt = 0; attempt < 3; attempt++) await runPlan(f, f.decision);

  assert.equal(f.sender.sent.length, 1, 'the same approved reply was delivered more than once');
  assert.equal(await f.repos.outbox.count(), 1);
  assert.equal((await f.repos.outbox.listByStatus('sent')).length, 1);
  assert.equal(await f.repos.companies.count(), 7, 'the CRM was written more than once');

  await f.close();
});

// --- 13  recipient integrity ------------------------------------------------

test('the recipient comes from the approved plan, and a mismatch is refused', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);

  // Simulate an outbox row that disagrees with the plan — the shape a tampered
  // or stale queue entry would take.
  await f.repos.outbox.create({
    emailId: f.email.id,
    decisionId: f.decision.id,
    toEmail: 'attacker@evil.example',
    subject: f.decision.plan.draft?.subject as string,
    body: f.decision.plan.draft?.body as string,
    status: 'queued',
    suppressedReason: null,
  });

  const outcome = await runPlan(f, f.decision);
  assert.equal(outcome.ok, true);

  assert.equal(f.sender.calls.length, 0, 'a message was sent to an address the plan never named');
  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'failed');
  assert.equal(outbox?.suppressedReason, 'recipient_mismatch');

  const blocked = (await f.repos.audit.listByEmail(f.email.id)).find(
    (event) => event.eventType === 'outbound_send_blocked',
  );
  assert.ok(blocked, 'a blocked send was not audited');

  await f.close();
});

// --- 14  the browser cannot turn this on ------------------------------------

test('no request body can enable outbound sending', async () => {
  const f = await pending();

  // The handler takes a decision id and an operator name. There is no argument,
  // header or body field anywhere in the chain that selects a sender — the
  // executor's default comes from `createOutboundSender()`, which reads only
  // the process environment.
  // No sender is injected: the executor falls back to `createOutboundSender()`,
  // which reads the process environment and nothing else.
  const response = await handleApprove(deps(f.repos), f.decision.id, 'sameer');

  assert.equal(response.body.ok, true);
  const outbox = await f.repos.outbox.findForDecision(f.decision.id);
  assert.equal(outbox?.status, 'suppressed', 'the default configuration delivered a message');
  assert.equal((await f.repos.outbox.listByStatus('sent')).length, 0);

  // And the config layer ignores anything that looks like a request field.
  const forged = loadConfig({ send: 'true', allowOutbound: 'true' } as NodeJS.ProcessEnv);
  assert.equal(forged.config.allowOutboundSend, false);
  assert.equal(outboundSendingPossible(forged.config.allowOutboundSend, forged.config.outboundProvider), false);

  await f.close();
});

// --- 15, 16  the audit trail ------------------------------------------------

test('the audit trail records the attempt without the reply text or any credential', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);
  await runPlan(f, f.decision);

  const events = await f.repos.audit.listByEmail(f.email.id);
  const outbound = events.filter((event) => event.eventType.startsWith('outbound_send_'));

  assert.deepEqual(
    outbound.map((event) => event.eventType),
    ['outbound_send_attempted', 'outbound_send_succeeded'],
  );

  const serialised = JSON.stringify(outbound);
  const body = f.decision.plan.draft?.body as string;
  assert.ok(!serialised.includes(body.slice(0, 40)), 'the audit log captured the reply body');
  assert.ok(!serialised.includes(f.email.bodyText.slice(0, 40)), 'the audit log captured the email body');
  assert.ok(!/sk-|api[_-]?key|password|secret|token/i.test(serialised), 'the audit log mentioned a credential');

  // The recipient and provider are recorded — those are the facts an operator
  // needs to answer "did this go, and where?".
  const attempted = outbound[0];
  assert.ok(attempted);
  const payload = attempted.payload as { toEmail?: string; provider?: string };
  assert.equal(payload.toEmail, f.email.fromEmail);
  assert.equal(payload.provider, 'mock');

  await f.close();
});

test('a suppressed reply is audited as suppressed and never as attempted', async () => {
  const f = await pending();
  await approve(f.repos, f.decision);
  await runPlan(f, f.decision, createMockOutboundSender({ enabled: false }));

  const types = (await f.repos.audit.listByEmail(f.email.id)).map((event) => event.eventType);
  assert.ok(types.includes('outbox_suppressed'));
  assert.ok(!types.includes('outbound_send_attempted'), 'a disabled sender was recorded as attempted');
  assert.ok(!types.includes('outbound_send_succeeded'));

  await f.close();
});

// --- §20  the seed transaction, now bound to its transaction ----------------

test('seeding rolls back as one transaction across every repository', async () => {
  // Previously `repos.db.transaction(...)` with root-bound repositories: atomic
  // on SQLite by coincidence of a shared connection, and not atomic at all on
  // Postgres. This is the same regression test shape the executor got in
  // M4-C.2.1 — a root handle that refuses CRM inserts, which is the Postgres
  // pooling behaviour expressed on SQLite.
  const ctx = await createTestContext({ idPrefix: 'seed' });

  const guarded = createRepositories(
    {
      driver: ctx.db.driver,
      query: (sql, params) => ctx.db.query(sql, params),
      exec: (sql) => ctx.db.exec(sql),
      execute: (sql, params) => {
        if (/INSERT INTO (companies|contacts|deals|tasks|activities|notes)\b/i.test(sql)) {
          return Promise.reject(new Error(`a seed write escaped the transaction: ${sql.slice(0, 40)}`));
        }
        return ctx.db.execute(sql, params);
      },
      transaction: (fn) => ctx.db.transaction(fn),
      close: () => ctx.db.close(),
    },
    { clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000), newId: createSequentialIds('seed') },
  );

  const counts = await seedDemoData(guarded, readSeedFile(DEMO_DATA_DIR));
  assert.equal(counts.companies, 6, 'the seed did not run inside its transaction');
  assert.equal(await ctx.repos.companies.count(), 6);

  await ctx.close();
});

test('a failed seed leaves no partial data behind', async () => {
  const ctx = await createTestContext({ idPrefix: 'seedfail' });

  // The fault has to reach the repositories bound to the transaction, so this
  // wrapper rewraps every nested `tx` too — the opposite of the test above,
  // which poisons only the root handle.
  const failing = (target: Database): Database => ({
    driver: target.driver,
    query: (sql, params) => target.query(sql, params),
    exec: (sql) => target.exec(sql),
    execute: (sql, params) =>
      /INSERT INTO tasks\b/i.test(sql)
        ? Promise.reject(new Error('injected failure'))
        : target.execute(sql, params),
    transaction: (fn) => target.transaction((tx) => fn(failing(tx))),
    close: () => target.close(),
  });

  const faulty = createRepositories(failing(ctx.db), {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('seedfail'),
  });

  const err = await rejects(() => seedDemoData(faulty, readSeedFile(DEMO_DATA_DIR)));
  assert.match(err.message, /injected failure/);

  // Companies, contacts and deals were written before tasks failed. All gone.
  assert.equal(await ctx.repos.companies.count(), 0, 'a partial seed survived');
  assert.equal(await ctx.repos.contacts.count(), 0);
  assert.equal(await ctx.repos.deals.count(), 0);

  await ctx.close();
});
