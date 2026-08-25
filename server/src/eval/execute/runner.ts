import path from 'node:path';
import { createTestDatabase } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createRepositories } from '../../db/repositories/index.ts';
import { createFixedClock } from '../../lib/clock.ts';
import { createSequentialIds } from '../../lib/ids.ts';
import { createDemoEmailSource } from '../../adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../../adapters/llm/index.ts';
import { ingestEmails } from '../../agent/ingest/ingest.ts';
import { understandEmail } from '../../agent/understand/understand.ts';
import { resolveEmail } from '../../agent/resolve/resolve.ts';
import { decideEmail } from '../../agent/decide/decide.ts';
import { executePlan } from '../../agent/execute/executor.ts';
import { planFingerprint } from '../../domain/execution.ts';
import { sweepExpiredApprovals } from '../../agent/approve/expiry.ts';
import { handleListApprovals } from '../../handlers/emails.ts';
import { readSeedFile, seedDemoData } from '../../db/seed.ts';
import { createLogger } from '../../lib/logger.ts';
import type { EmailRecord } from '../../domain/email.ts';

// M4-A focused evaluation.
//
// Not the M6 harness — a narrow measurement of the four properties this
// milestone exists to guarantee, run over the whole demo dataset:
//
//   approvalBypassRate      a tier-2 plan that ran with no approval record
//   unauthorizedExecutions  an execution refused when it should have been allowed
//   duplicateSideEffects    CRM rows created twice by re-running the same plan
//   blockedSendRate         a guardrail-blocked draft that reached the outbox
//
// M4-B adds four more, about the expiry sweep. They are measured in their own
// world (see `measureExpiry`) because this one approves everything it decides,
// which would leave nothing pending to expire:
//
//   expiredNotExecutable    an expired approval that could still be run
//   expirySweepIdempotent   a second sweep that changed something
//   expiryAuditDuplicates   more than one expiry event for one approval
//   expiredShownActionable  an expired row the queue still offered to approve
//
// Every one of them must be zero. A safety measure with a tolerance is not one.

export type ExecuteReport = {
  metrics: {
    plansConsidered: number;
    approvedAndExecuted: number;
    refusedWithoutApproval: number;
    approvalBypassRate: number;
    unauthorizedExecutions: number;
    duplicateSideEffects: number;
    blockedSendRate: number;
    outboxSent: number;
    expiredSwept: number;
    expiredNotExecutable: number;
    expirySweepIdempotent: boolean;
    expiryAuditDuplicates: number;
    expiredShownActionable: number;
    queueOrderedBySla: boolean;
  };
  detail: string[];
};

type ExpiryMetrics = Pick<
  ExecuteReport['metrics'],
  | 'expiredSwept'
  | 'expiredNotExecutable'
  | 'expirySweepIdempotent'
  | 'expiryAuditDuplicates'
  | 'expiredShownActionable'
  | 'queueOrderedBySla'
>;

type Counts = {
  companies: number;
  contacts: number;
  deals: number;
  tasks: number;
  activities: number;
  notes: number;
};

export async function runExecuteEvaluation(options: {
  demoDataDir: string;
  migrationsDir: string;
}): Promise<ExecuteReport> {
  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  const clock = createFixedClock('2026-06-01T00:00:00.000Z', 1000);
  const repos = createRepositories(db, { clock, newId: createSequentialIds('eval') });
  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', 'assisted', 'eval');

  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);
  const logger = createLogger('eval', { level: 'error' });
  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });

  const counts = async (): Promise<Counts> => ({
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
    notes: await repos.notes.count(),
  });

  await ingestEmails({ repos, source, logger });

  const detail: string[] = [];
  let plansConsidered = 0;
  let approvedAndExecuted = 0;
  let refusedWithoutApproval = 0;
  let approvalBypass = 0;
  let unauthorized = 0;
  let blockedSendReached = 0;

  for (const email of await repos.emails.list({ limit: 50 })) {
    const understood = await understandEmail(email, { repos, provider, logger });
    if (understood.state !== 'resolving') continue;

    const resolved = await resolveEmail(understood.email, { repos, logger });
    if (resolved.state !== 'deciding') continue;

    const decided = await decideEmail(resolved.email, { repos, provider, logger, clock });
    const decision = decided.decision;
    if (!decision || decision.plan.actions.length === 0) continue;
    plansConsidered++;

    const needsApproval = decision.plan.requiresApproval;

    if (needsApproval) {
      // 1. Try to execute with no approval. A plan that needs one and runs
      //    here is an approval bypass — the worst failure this system can have.
      const unapproved = await executePlan(decided.email, decision, { repos, clock, logger });
      if (unapproved.ok) {
        approvalBypass++;
        detail.push(`BYPASS: "${email.subject}" executed with no approval`);
        continue;
      }
      refusedWithoutApproval++;

      // 2. Now approve it properly and run it. This must succeed.
      await repos.approvals.decide(decision.id, 'approved', {
        decidedBy: 'eval',
        planHash: planFingerprint(decision.plan),
      });
      await repos.emails.setState(email.id, 'awaiting_approval');

      const authorised = await executePlan(
        (await repos.emails.getById(email.id)) as EmailRecord,
        decision,
        { repos, clock, logger },
      );
      if (authorised.ok) {
        approvedAndExecuted++;
      } else {
        unauthorized++;
        detail.push(`UNEXPECTED REFUSAL: "${email.subject}" — ${authorised.refusalMessage ?? authorised.refusedWith}`);
      }
    } else {
      // A plan needing no approval is authorised by the policy itself, so the
      // first attempt IS the real one — running it twice here would just be
      // measuring the idempotency guard, which section 4 already does.
      const authorised = await executePlan(decided.email, decision, { repos, clock, logger });
      if (authorised.ok) {
        approvedAndExecuted++;
      } else {
        unauthorized++;
        detail.push(`UNEXPECTED REFUSAL: "${email.subject}" — ${authorised.refusalMessage ?? authorised.refusedWith}`);
      }
    }

    // 3. A blocked draft must never reach the outbox.
    if ((decision.plan.draft?.blockedBy.length ?? 0) > 0) {
      const outbox = await repos.outbox.findForDecision(decision.id);
      if (outbox !== null) {
        blockedSendReached++;
        detail.push(`BLOCKED DRAFT QUEUED: "${email.subject}"`);
      }
    }
  }

  // 4. Duplicate side effects: re-run every plan and see whether the CRM grows.
  const before = await counts();

  for (const email of await repos.emails.list({ limit: 50 })) {
    const decision = await repos.decisions.getCurrentForEmail(email.id);
    if (!decision || decision.plan.actions.length === 0) continue;
    await repos.emails.setState(email.id, 'awaiting_approval');
    await executePlan((await repos.emails.getById(email.id)) as EmailRecord, decision, { repos, clock, logger });
  }

  const after = await counts();
  const duplicateSideEffects = (Object.keys(before) as Array<keyof Counts>).reduce(
    (sum, key) => sum + (after[key] - before[key]),
    0,
  );
  if (duplicateSideEffects > 0) detail.push(`DUPLICATES: ${duplicateSideEffects} extra CRM row(s) on re-run`);

  const outboxSent = (await repos.outbox.listByStatus('sent')).length;
  await db.close();

  // 5. Expiry (M4-B), measured on its own untouched world.
  const expiry = await measureExpiry(options);
  detail.push(...expiry.detail);

  return {
    metrics: {
      plansConsidered,
      approvedAndExecuted,
      refusedWithoutApproval,
      approvalBypassRate: plansConsidered === 0 ? 0 : Number((approvalBypass / plansConsidered).toFixed(4)),
      unauthorizedExecutions: unauthorized,
      duplicateSideEffects,
      blockedSendRate: blockedSendReached,
      outboxSent,
      ...expiry.metrics,
    },
    detail,
  };
}

/**
 * The M4-B expiry measurement.
 *
 * Runs the pipeline as far as DECIDE and then stops, so every approval it
 * produces is genuinely pending — the state the sweep exists to act on. The
 * main evaluation cannot host this: it approves everything it decides, so by
 * the time it finished there would be nothing left to expire and the check
 * would pass silently while proving nothing.
 */
async function measureExpiry(options: {
  demoDataDir: string;
  migrationsDir: string;
}): Promise<{ metrics: ExpiryMetrics; detail: string[] }> {
  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  const clock = createFixedClock('2026-06-01T00:00:00.000Z', 1000);
  const repos = createRepositories(db, { clock, newId: createSequentialIds('expiry') });
  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', 'assisted', 'eval');

  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);
  const logger = createLogger('eval', { level: 'error' });
  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });

  await ingestEmails({ repos, source, logger });

  for (const email of await repos.emails.list({ limit: 50 })) {
    const understood = await understandEmail(email, { repos, provider, logger });
    if (understood.state !== 'resolving') continue;
    const resolved = await resolveEmail(understood.email, { repos, logger });
    if (resolved.state !== 'deciding') continue;
    await decideEmail(resolved.email, { repos, provider, logger, clock });
  }

  const detail: string[] = [];

  // 1. Queue ordering, through the real handler rather than a reimplementation
  //    of its sort. Least time remaining first (spec §13.4).
  const live = await handleListApprovals({ repos, clock }, { state: 'pending' });
  const order = live.body.approvals.map((row) => row.msToExpiry);
  const queueOrderedBySla = order.every((value, index) => index === 0 || value >= (order[index - 1] as number));
  if (!queueOrderedBySla) detail.push(`QUEUE MIS-ORDERED: ${order.join(', ')}`);

  // 2. Push every pending approval past its window.
  for (const approval of await repos.approvals.listByState('pending', 200)) {
    await db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
      '2020-01-01T00:00:00.000Z',
      approval.decisionId,
    ]);
  }

  // An overdue row must stop being offered as work the moment it is overdue —
  // before the sweep has run, not only after it.
  const stale = await handleListApprovals({ repos, clock }, { state: 'pending' });
  let expiredShownActionable = stale.body.approvals.filter((row) => row.actionable).length;
  if (expiredShownActionable > 0) {
    detail.push(`${expiredShownActionable} overdue row(s) still offered as approvable before the sweep`);
  }

  const firstSweep = await sweepExpiredApprovals({ repos, clock, logger, limit: 200 });
  const secondSweep = await sweepExpiredApprovals({ repos, clock, logger, limit: 200 });
  const expirySweepIdempotent = secondSweep.expired.length === 0;
  if (!expirySweepIdempotent) detail.push('EXPIRY NOT IDEMPOTENT: a second sweep changed something');

  // 3. And it must not come back as actionable in the expired tab either.
  const settled = await handleListApprovals({ repos, clock }, { state: 'expired' });
  expiredShownActionable += settled.body.approvals.filter((row) => row.actionable).length;

  let expiredNotExecutable = 0;
  let expiryAuditDuplicates = 0;

  for (const swept of firstSweep.expired) {
    const decision = await repos.decisions.getById(swept.decisionId);
    if (!decision) continue;

    // Force the email back to an executable state so the approval check — not
    // the state guard — is what has to refuse.
    await repos.emails.setState(swept.emailId, 'awaiting_approval');
    const attempt = await executePlan(
      (await repos.emails.getById(swept.emailId)) as EmailRecord,
      decision,
      { repos, clock, logger },
    );
    if (attempt.ok) {
      expiredNotExecutable++;
      detail.push(`EXPIRED PLAN RAN: "${swept.subject}"`);
    }

    const events = (await repos.audit.listByEmail(swept.emailId)).filter(
      (event) => event.eventType === 'approval_expired',
    );
    if (events.length > 1) {
      expiryAuditDuplicates += events.length - 1;
      detail.push(`DUPLICATE EXPIRY EVENTS: "${swept.subject}" has ${events.length}`);
    }
  }

  await db.close();

  return {
    metrics: {
      expiredSwept: firstSweep.expired.length,
      expiredNotExecutable,
      expirySweepIdempotent,
      expiryAuditDuplicates,
      expiredShownActionable,
      queueOrderedBySla,
    },
    detail,
  };
}

export function executeThresholdFailures(metrics: ExecuteReport['metrics']): string[] {
  const failures: string[] = [];
  if (metrics.approvalBypassRate > 0) failures.push(`approval bypass rate ${metrics.approvalBypassRate} — must be 0`);
  if (metrics.unauthorizedExecutions > 0) failures.push(`${metrics.unauthorizedExecutions} unauthorized execution(s)`);
  if (metrics.duplicateSideEffects > 0) failures.push(`${metrics.duplicateSideEffects} duplicate side effect(s)`);
  if (metrics.blockedSendRate > 0) failures.push(`${metrics.blockedSendRate} blocked draft(s) reached the outbox`);
  if (metrics.outboxSent > 0) failures.push(`${metrics.outboxSent} message(s) marked sent — nothing may ever be sent`);
  if (metrics.expiredNotExecutable > 0) failures.push(`${metrics.expiredNotExecutable} expired approval(s) still executed`);
  if (!metrics.expirySweepIdempotent) failures.push('the expiry sweep is not idempotent');
  if (metrics.expiryAuditDuplicates > 0) failures.push(`${metrics.expiryAuditDuplicates} duplicate expiry audit event(s)`);
  if (metrics.expiredShownActionable > 0) failures.push(`${metrics.expiredShownActionable} expired approval(s) offered as actionable`);
  if (metrics.expiredSwept === 0) failures.push('nothing was expired; the expiry check proved nothing');
  if (!metrics.queueOrderedBySla) failures.push('the approval queue is not ordered by SLA remaining');
  if (metrics.plansConsidered === 0) failures.push('no plans were considered; the evaluation proved nothing');
  return failures;
}
