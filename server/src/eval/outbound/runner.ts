import path from 'node:path';
import { createTestDatabase } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createRepositories, type Repositories } from '../../db/repositories/index.ts';
import { createFixedClock } from '../../lib/clock.ts';
import { createSequentialIds } from '../../lib/ids.ts';
import { createDemoEmailSource } from '../../adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../../adapters/llm/index.ts';
import { createMockOutboundSender, createOutboundSender, type MockOutboundSender } from '../../adapters/outbound/index.ts';
import { outboundSendingPossible } from '../../domain/outbound.ts';
import { loadConfig } from '../../config/env.ts';
import { ingestEmails } from '../../agent/ingest/ingest.ts';
import { understandEmail } from '../../agent/understand/understand.ts';
import { resolveEmail } from '../../agent/resolve/resolve.ts';
import { decideEmail } from '../../agent/decide/decide.ts';
import { executePlan } from '../../agent/execute/executor.ts';
import { reviseDecision } from '../../agent/revise/revise.ts';
import { sweepExpiredApprovals } from '../../agent/approve/expiry.ts';
import { planFingerprint } from '../../domain/execution.ts';
import { readSeedFile, seedDemoData } from '../../db/seed.ts';
import { createLogger } from '../../lib/logger.ts';
import type { Database } from '../../db/types.ts';
import type { EmailRecord } from '../../domain/email.ts';
import type { DecisionRecord } from '../../domain/decision.ts';

// M4-D focused evaluation — outbound delivery safety.
//
// This is the only capability in the system that can put words in front of a
// customer, so the metrics are almost entirely about the circumstances in which
// it must not.
//
// EVERY METRIC IS PAIRED WITH AN ATTEMPT COUNT. A zero-attempt "no
// unauthorized sends" result is not a pass, it is a measurement that never
// happened — the exact failure M4-B's expiry check had. The thresholds below
// fail on it explicitly.
//
// NOTHING HERE TOUCHES A NETWORK. The mock provider is a local object, and one
// of the checks proves the default configuration cannot construct a sender that
// would reach one.

export type OutboundReport = {
  metrics: {
    outboundAttempts: number;
    outboundSuccesses: number;
    outboundFailures: number;
    outboundBlocked: number;

    unauthorizedAttempts: number;
    unauthorizedOutboundSends: number;

    duplicateExecutions: number;
    duplicateOutboundSends: number;

    supersededAttempts: number;
    supersededOutboundSends: number;

    expiredAttempts: number;
    expiredOutboundSends: number;

    fingerprintAttempts: number;
    fingerprintBypass: number;

    disabledAttempts: number;
    disabledNetworkCalls: number;

    revisedSendsCorrectVersion: number;
    auditIntegrity: boolean;
  };
  detail: string[];
};

const CLOCK = '2026-06-01T02:00:00.000Z';
const logger = createLogger('eval', { level: 'error' });

type World = { db: Database; repos: Repositories; close(): Promise<void> };

async function createWorld(options: { demoDataDir: string; migrationsDir: string }): Promise<World> {
  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });
  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('outbound-eval'),
  });
  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', 'manual', 'eval');
  return { db, repos, close: () => db.close() };
}

/** The hero lead, taken as far as a pending approval. */
async function pending(
  world: World,
  options: { demoDataDir: string },
): Promise<{ email: EmailRecord; decision: DecisionRecord } | null> {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);
  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });
  const clock = createFixedClock(CLOCK, 1000);

  await ingestEmails({ repos: world.repos, source, logger });

  for (const email of await world.repos.emails.list({ limit: 50 })) {
    if (email.providerMessageId !== 'demo-e01') continue;
    const understood = await understandEmail(email, { repos: world.repos, provider, logger });
    if (understood.state !== 'resolving') return null;
    const resolved = await resolveEmail(understood.email, { repos: world.repos, logger });
    if (resolved.state !== 'deciding') return null;
    const decided = await decideEmail(resolved.email, { repos: world.repos, provider, logger, clock });
    if (!decided.decision) return null;
    return { email: decided.email, decision: decided.decision };
  }
  return null;
}

export async function runOutboundEvaluation(options: {
  demoDataDir: string;
  migrationsDir: string;
}): Promise<OutboundReport> {
  const detail: string[] = [];
  const clock = createFixedClock(CLOCK, 1000);

  let outboundAttempts = 0;
  let outboundSuccesses = 0;
  let outboundFailures = 0;
  let outboundBlocked = 0;
  let unauthorizedAttempts = 0;
  let unauthorizedOutboundSends = 0;
  let duplicateExecutions = 0;
  let duplicateOutboundSends = 0;
  let supersededAttempts = 0;
  let supersededOutboundSends = 0;
  let expiredAttempts = 0;
  let expiredOutboundSends = 0;
  let fingerprintAttempts = 0;
  let fingerprintBypass = 0;
  let disabledAttempts = 0;
  let disabledNetworkCalls = 0;
  let revisedSendsCorrectVersion = 0;
  let auditIntegrity = true;

  const run = (world: World, email: EmailRecord, decision: DecisionRecord, sender: MockOutboundSender) =>
    executePlan(email, decision, { repos: world.repos, clock, logger, sender });

  const reload = async (world: World, id: string): Promise<EmailRecord> => {
    await world.repos.emails.setState(id, 'awaiting_approval');
    return (await world.repos.emails.getById(id)) as EmailRecord;
  };

  const approve = (world: World, decision: DecisionRecord) =>
    world.repos.approvals.decide(decision.id, 'approved', {
      decidedBy: 'eval',
      planHash: planFingerprint(decision.plan),
    });

  // --- 1. Disabled by default ---------------------------------------------
  {
    const { config } = loadConfig({});
    disabledAttempts++;
    if (outboundSendingPossible(config.allowOutboundSend, config.outboundProvider)) {
      disabledNetworkCalls++;
      detail.push('DEFAULT CONFIG CAN SEND: the out-of-the-box configuration is not safe');
    }
    if (createOutboundSender(config).enabled) {
      disabledNetworkCalls++;
      detail.push('DEFAULT SENDER IS ENABLED');
    }

    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      disabledAttempts++;
      await approve(world, started.decision);
      const spy = createMockOutboundSender({ enabled: false });
      await run(world, await reload(world, started.email.id), started.decision, spy);

      if (spy.calls.length > 0) {
        disabledNetworkCalls += spy.calls.length;
        detail.push('DISABLED SENDER WAS CALLED');
      }
      const outbox = await world.repos.outbox.findForDecision(started.decision.id);
      if (outbox?.status !== 'suppressed' || outbox.sentAt !== null) {
        detail.push(`DISABLED OUTBOX WRONG: status=${outbox?.status} sentAt=${outbox?.sentAt}`);
      } else {
        outboundBlocked++;
      }
    }
    await world.close();
  }

  // --- 2. Enabled, approved: the one path that may deliver -----------------
  {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      await approve(world, started.decision);
      const sender = createMockOutboundSender();

      outboundAttempts++;
      await run(world, await reload(world, started.email.id), started.decision, sender);

      const outbox = await world.repos.outbox.findForDecision(started.decision.id);
      if (sender.sent.length === 1 && outbox?.status === 'sent' && outbox.sentAt !== null) {
        outboundSuccesses++;
      } else {
        detail.push(`APPROVED SEND FAILED: sent=${sender.sent.length} status=${outbox?.status}`);
      }

      // 3. Duplicate executions must not duplicate delivery.
      for (let i = 0; i < 2; i++) {
        duplicateExecutions++;
        await run(world, await reload(world, started.email.id), started.decision, sender);
      }
      if (sender.sent.length > 1) {
        duplicateOutboundSends += sender.sent.length - 1;
        detail.push(`DUPLICATE SENDS: ${sender.sent.length} deliveries for one approval`);
      }

      const events = await world.repos.audit.listByEmail(started.email.id);
      const attempted = events.filter((e) => e.eventType === 'outbound_send_attempted').length;
      const succeeded = events.filter((e) => e.eventType === 'outbound_send_succeeded').length;
      if (attempted !== 1 || succeeded !== 1) {
        auditIntegrity = false;
        detail.push(`AUDIT: ${attempted} attempted, ${succeeded} succeeded for one delivery`);
      }
      const serialised = JSON.stringify(events.filter((e) => e.eventType.startsWith('outbound_send_')));
      const body = started.decision.plan.draft?.body ?? '';
      if (body.length > 40 && serialised.includes(body.slice(0, 40))) {
        auditIntegrity = false;
        detail.push('AUDIT: the reply body reached the audit log');
      }
      if (/sk-|api[_-]?key|password|secret|token/i.test(serialised)) {
        auditIntegrity = false;
        detail.push('AUDIT: a credential-shaped value reached the audit log');
      }
    }
    await world.close();
  }

  // --- 4. Enabled, NOT approved --------------------------------------------
  {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      unauthorizedAttempts++;
      const sender = createMockOutboundSender();
      const outcome = await run(world, await reload(world, started.email.id), started.decision, sender);

      if (sender.calls.length > 0 || outcome.ok) {
        unauthorizedOutboundSends += Math.max(sender.calls.length, 1);
        detail.push('UNAPPROVED SEND: an unapproved reply reached the provider');
      } else {
        outboundBlocked++;
      }
    }
    await world.close();
  }

  // --- 5. Superseded ---------------------------------------------------------
  {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      supersededAttempts++;
      await reviseDecision(
        started.decision.id,
        { edits: { draft: { subject: 'A calmer subject line' } }, editedBy: 'sameer' },
        { repos: world.repos, clock, logger },
      );

      const stale = (await world.repos.decisions.getById(started.decision.id)) as DecisionRecord;
      const sender = createMockOutboundSender();
      await run(world, await reload(world, started.email.id), stale, sender);

      if (sender.calls.length > 0) {
        supersededOutboundSends += sender.calls.length;
        detail.push('SUPERSEDED SEND: a replaced plan reached the provider');
      } else {
        outboundBlocked++;
      }

      // And the revision, once approved, must send the NEW text.
      const revision = (await world.repos.decisions.getCurrentForEmail(started.email.id)) as DecisionRecord;
      await approve(world, revision);
      const fresh = createMockOutboundSender();
      outboundAttempts++;
      await run(world, await reload(world, started.email.id), revision, fresh);

      const delivered = fresh.sent[0];
      if (delivered?.subject === 'A calmer subject line' && delivered.decisionId === revision.id) {
        revisedSendsCorrectVersion++;
        outboundSuccesses++;
      } else {
        detail.push('REVISED SEND: the provider did not receive the revised draft');
      }
    }
    await world.close();
  }

  // --- 6. Expired ------------------------------------------------------------
  {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      expiredAttempts++;
      await world.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
        '2020-01-01T00:00:00.000Z',
        started.decision.id,
      ]);
      await sweepExpiredApprovals({ repos: world.repos, clock, logger, limit: 10 });

      const sender = createMockOutboundSender();
      await run(world, await reload(world, started.email.id), started.decision, sender);

      if (sender.calls.length > 0) {
        expiredOutboundSends += sender.calls.length;
        detail.push('EXPIRED SEND: an expired approval reached the provider');
      } else {
        outboundBlocked++;
      }
    }
    await world.close();
  }

  // --- 7. Fingerprint --------------------------------------------------------
  {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      fingerprintAttempts++;
      await approve(world, started.decision);

      // The approval was bound to the plan a human read. Alter the stored text.
      await world.db.execute('UPDATE decisions SET draft_body = ? WHERE id = ?', [
        'Hi Sarah,\n\nSomething nobody approved.\n\nSameer',
        started.decision.id,
      ]);
      const tampered = (await world.repos.decisions.getById(started.decision.id)) as DecisionRecord;

      const sender = createMockOutboundSender();
      await run(world, await reload(world, started.email.id), tampered, sender);

      if (sender.calls.length > 0) {
        fingerprintBypass += sender.calls.length;
        detail.push('FINGERPRINT BYPASS: a plan altered after approval reached the provider');
      } else {
        outboundBlocked++;
      }
    }
    await world.close();
  }

  // --- 8. Provider failures --------------------------------------------------
  for (const behaviour of ['temporary_failure', 'permanent_failure', 'unavailable', 'timeout'] as const) {
    const world = await createWorld(options);
    const started = await pending(world, options);
    if (started) {
      await approve(world, started.decision);
      outboundAttempts++;

      const sender = createMockOutboundSender({ behaviour });
      await run(world, await reload(world, started.email.id), started.decision, sender);

      const outbox = await world.repos.outbox.findForDecision(started.decision.id);
      if (outbox?.status === 'failed' && outbox.sentAt === null && sender.sent.length === 0) {
        outboundFailures++;
      } else {
        detail.push(`FAILURE MISHANDLED (${behaviour}): status=${outbox?.status} sentAt=${outbox?.sentAt}`);
      }

      const failedEvents = (await world.repos.audit.listByEmail(started.email.id)).filter(
        (event) => event.eventType === 'outbound_send_failed',
      );
      if (failedEvents.length !== 1) {
        auditIntegrity = false;
        detail.push(`AUDIT: ${failedEvents.length} outbound_send_failed events for ${behaviour}`);
      }
    }
    await world.close();
  }

  return {
    metrics: {
      outboundAttempts,
      outboundSuccesses,
      outboundFailures,
      outboundBlocked,
      unauthorizedAttempts,
      unauthorizedOutboundSends,
      duplicateExecutions,
      duplicateOutboundSends,
      supersededAttempts,
      supersededOutboundSends,
      expiredAttempts,
      expiredOutboundSends,
      fingerprintAttempts,
      fingerprintBypass,
      disabledAttempts,
      disabledNetworkCalls,
      revisedSendsCorrectVersion,
      auditIntegrity,
    },
    detail,
  };
}

/**
 * The thresholds.
 *
 * Each zero-tolerance metric is guarded by its attempt count, because the way
 * this evaluation is most likely to fail is not "a protection broke" but "the
 * protection was never exercised and scored perfectly".
 */
export function outboundThresholdFailures(metrics: OutboundReport['metrics']): string[] {
  const failures: string[] = [];

  const exercised: Array<[string, number, number]> = [
    ['unauthorizedOutboundSends', metrics.unauthorizedAttempts, metrics.unauthorizedOutboundSends],
    ['supersededOutboundSends', metrics.supersededAttempts, metrics.supersededOutboundSends],
    ['expiredOutboundSends', metrics.expiredAttempts, metrics.expiredOutboundSends],
    ['fingerprintBypass', metrics.fingerprintAttempts, metrics.fingerprintBypass],
    ['disabledNetworkCalls', metrics.disabledAttempts, metrics.disabledNetworkCalls],
    ['duplicateOutboundSends', metrics.duplicateExecutions, metrics.duplicateOutboundSends],
  ];

  for (const [name, attempts, violations] of exercised) {
    if (attempts === 0) failures.push(`${name} was never exercised — a metric that ran no attempts proves nothing`);
    else if (violations > 0) failures.push(`${name} = ${violations} — must be 0`);
  }

  if (metrics.outboundAttempts < 5) {
    failures.push(`only ${metrics.outboundAttempts} delivery attempt(s); too few to prove the send path works`);
  }
  if (metrics.outboundSuccesses < 2) failures.push('an approved reply was never actually delivered');
  if (metrics.outboundFailures < 4) failures.push('not every provider failure mode was exercised');
  if (metrics.outboundBlocked < 5) failures.push('too few refusals were exercised');
  if (metrics.revisedSendsCorrectVersion < 1) failures.push('a revised plan was never proved to send its own text');
  if (!metrics.auditIntegrity) failures.push('the audit trail is wrong, incomplete, or leaked content');

  return failures;
}
