import path from 'node:path';
import { createTestDatabase } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createRepositories, type Repositories } from '../../db/repositories/index.ts';
import { createFixedClock } from '../../lib/clock.ts';
import { createSequentialIds } from '../../lib/ids.ts';
import { createDemoEmailSource } from '../../adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../../adapters/llm/index.ts';
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

// M4-C focused evaluation — the human revision lifecycle.
//
// Deterministic, offline, no API key. It measures the properties that make
// "a person may change the plan" safe rather than merely possible:
//
//   originalPreserved        the plan a human edited still says what it said
//   supersededCorrectly      the old approval is retired, not left pending
//   newApprovalPending       an edit produces work, never authority
//   approvalPolicyPreserved  a settings change cannot weaken a revision
//   unsafeEditBlocked        a human cannot write what the model could not
//   atomicRollback           a failed revision leaves nothing behind
//   executableOnlyAfterApproval  the revision still has to be approved
//   duplicateSideEffects     re-running an approved revision writes once
//   expiredRevisionNotExecutable  a timeout never resolves toward acting
//   auditIntegrity           every step is on the record, exactly once
//
// NO METRIC MAY PASS VACUOUSLY.
//
// M4-B taught this the hard way: an expiry check ran in a world where nothing
// was left to expire, reported a perfect score, and proved nothing. So every
// rate below is paired with the count of attempts that produced it, and the
// thresholds fail when an attempt count is zero. A safety measure that was
// never exercised is not a passing safety measure.

export type ReviseReport = {
  metrics: {
    revisionAttempts: number;
    revisionSuccess: number;
    originalPreserved: number;
    supersededCorrectly: number;
    newApprovalPending: number;
    fingerprintChanged: number;

    policyAttempts: number;
    approvalPolicyPreserved: number;

    unsafeEditAttempts: number;
    unsafeEditBlocked: number;

    rollbackAttempts: number;
    atomicRollback: number;

    executableOnlyAfterApproval: number;
    duplicateSideEffects: number;

    expiryAttempts: number;
    expiredRevisionNotExecutable: number;

    auditIntegrity: boolean;
    outboxSent: number;
  };
  detail: string[];
};

type World = {
  db: Database;
  repos: Repositories;
  close(): Promise<void>;
};

const CLOCK = '2026-06-01T02:00:00.000Z';
const logger = createLogger('eval', { level: 'error' });

async function createWorld(options: { demoDataDir: string; migrationsDir: string }, autonomy: string): Promise<World> {
  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('revise-eval'),
  });
  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', autonomy as 'manual', 'eval');

  return { db, repos, close: () => db.close() };
}

/** Runs the pipeline as far as a pending approval for one demo email. */
async function pending(
  world: World,
  options: { demoDataDir: string },
  providerMessageId: string,
): Promise<{ email: EmailRecord; decision: DecisionRecord } | null> {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);
  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });
  const clock = createFixedClock(CLOCK, 1000);

  await ingestEmails({ repos: world.repos, source, logger });

  for (const email of await world.repos.emails.list({ limit: 50 })) {
    if (email.providerMessageId !== providerMessageId) continue;

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

async function crmCounts(repos: Repositories): Promise<number[]> {
  return [
    await repos.companies.count(),
    await repos.contacts.count(),
    await repos.deals.count(),
    await repos.tasks.count(),
    await repos.activities.count(),
    await repos.notes.count(),
  ];
}

/** A database that fails one statement, propagating the fault into nested transactions. */
function failingOn(inner: Database, pattern: RegExp): Database {
  const wrap = (target: Database): Database => ({
    driver: target.driver,
    query: (sql, params) => target.query(sql, params),
    exec: (sql) => target.exec(sql),
    execute: (sql, params) => {
      if (pattern.test(sql)) return Promise.reject(new Error('injected failure'));
      return target.execute(sql, params);
    },
    transaction: (fn) => target.transaction((tx) => fn(wrap(tx))),
    close: () => target.close(),
  });
  return wrap(inner);
}

export async function runReviseEvaluation(options: {
  demoDataDir: string;
  migrationsDir: string;
}): Promise<ReviseReport> {
  const detail: string[] = [];
  const clock = createFixedClock(CLOCK, 1000);

  let revisionAttempts = 0;
  let revisionSuccess = 0;
  let originalPreserved = 0;
  let supersededCorrectly = 0;
  let newApprovalPending = 0;
  let fingerprintChanged = 0;
  let executableOnlyAfterApproval = 0;
  let duplicateSideEffects = 0;
  let outboxSent = 0;
  let auditIntegrity = true;

  // --- 1. The main path, over every editable demo plan --------------------
  //
  // One world per email so a failure in one cannot mask another, and so the
  // "original preserved" comparison is against an untouched baseline.
  for (const messageId of ['demo-e01', 'demo-e02', 'demo-e03', 'demo-e05']) {
    const world = await createWorld(options, 'manual');
    const started = await pending(world, options, messageId);
    if (!started) {
      await world.close();
      continue;
    }

    const { email, decision } = started;
    const approval = await world.repos.approvals.getForDecision(decision.id);
    if (approval?.state !== 'pending') {
      await world.close();
      continue;
    }

    const taskIndex = decision.plan.actions.findIndex((action) => action.type === 'create_task');
    const edits: Record<string, unknown> = {};
    if (decision.plan.draft !== null) {
      edits.draft = { subject: 'Thanks for getting in touch about your store' };
    }
    if (taskIndex >= 0) {
      edits.actions = [{ index: taskIndex, field: 'title', value: 'Call them back this week' }];
    }
    if (Object.keys(edits).length === 0) {
      await world.close();
      continue;
    }

    revisionAttempts++;
    const before = await crmCounts(world.repos);

    try {
      const result = await reviseDecision(decision.id, { edits, editedBy: 'sameer' }, {
        repos: world.repos,
        clock,
        logger,
      });
      revisionSuccess++;

      const v1 = await world.repos.decisions.getById(decision.id);
      if (v1 && JSON.stringify(v1.plan) === JSON.stringify(decision.plan)) originalPreserved++;
      else detail.push(`ORIGINAL MUTATED: ${messageId}`);

      if ((await world.repos.approvals.getForDecision(decision.id))?.state === 'superseded') supersededCorrectly++;
      else detail.push(`NOT SUPERSEDED: ${messageId}`);

      if (result.approval.state === 'pending' && result.approval.decisionId === result.decision.id) {
        newApprovalPending++;
      } else {
        detail.push(`REVISION DID NOT OPEN A FRESH APPROVAL: ${messageId}`);
      }

      if (planFingerprint(result.decision.plan) !== planFingerprint(decision.plan)) fingerprintChanged++;
      else detail.push(`FINGERPRINT UNCHANGED: ${messageId}`);

      // The revision is work, not permission: it must refuse until approved.
      const unapproved = await executePlan(
        (await world.repos.emails.getById(email.id)) as EmailRecord,
        result.decision,
        { repos: world.repos, clock, logger },
      );
      if (unapproved.ok) {
        detail.push(`REVISION RAN UNAPPROVED: ${messageId}`);
      } else if (JSON.stringify(await crmCounts(world.repos)) === JSON.stringify(before)) {
        executableOnlyAfterApproval++;
      }

      // Approve it properly, then run it three times.
      await world.repos.approvals.decide(result.decision.id, 'approved', {
        decidedBy: 'eval',
        planHash: planFingerprint(result.decision.plan),
      });
      await world.repos.emails.setState(email.id, 'awaiting_approval');
      const first = await executePlan(
        (await world.repos.emails.getById(email.id)) as EmailRecord,
        result.decision,
        { repos: world.repos, clock, logger },
      );
      if (!first.ok) detail.push(`APPROVED REVISION REFUSED: ${messageId} — ${first.refusalMessage ?? ''}`);

      const afterFirst = await crmCounts(world.repos);
      for (let attempt = 0; attempt < 2; attempt++) {
        await world.repos.emails.setState(email.id, 'awaiting_approval');
        await executePlan(
          (await world.repos.emails.getById(email.id)) as EmailRecord,
          result.decision,
          { repos: world.repos, clock, logger },
        );
      }
      const afterRepeats = await crmCounts(world.repos);
      const extra = afterRepeats.reduce((sum, value, index) => sum + (value - (afterFirst[index] as number)), 0);
      if (extra > 0) {
        duplicateSideEffects += extra;
        detail.push(`DUPLICATES: ${messageId} grew by ${extra} row(s) on re-run`);
      }

      // Nothing may ever be sent.
      outboxSent += (await world.repos.outbox.listByStatus('sent')).length;

      // Audit: one plan_revised and one approval_superseded, no more.
      const events = await world.repos.audit.listByEmail(email.id);
      const revised = events.filter((event) => event.eventType === 'plan_revised').length;
      const superseded = events.filter((event) => event.eventType === 'approval_superseded').length;
      if (revised !== 1 || superseded !== 1) {
        auditIntegrity = false;
        detail.push(`AUDIT: ${messageId} has ${revised} plan_revised and ${superseded} approval_superseded`);
      }
    } catch (err) {
      detail.push(`REVISION FAILED: ${messageId} — ${err instanceof Error ? err.message : String(err)}`);
    }

    await world.close();
  }

  // --- 2. The policy floor -------------------------------------------------
  let policyAttempts = 0;
  let approvalPolicyPreserved = 0;
  {
    const world = await createWorld(options, 'manual');
    const started = await pending(world, options, 'demo-e05');

    if (started && started.decision.plan.requiresApproval) {
      policyAttempts++;
      // Loosen the setting after the plan was made — the one route by which a
      // recomputation could legitimately come back weaker.
      await world.repos.settings.set('autonomy_level', 'autonomous_low_risk', 'eval');
      const taskIndex = started.decision.plan.actions.findIndex((action) => action.type === 'create_task');

      const result = await reviseDecision(
        started.decision.id,
        { edits: { actions: [{ index: taskIndex, field: 'title', value: 'Call them back' }] }, editedBy: 'sameer' },
        { repos: world.repos, clock, logger },
      );

      const refused = await executePlan(
        (await world.repos.emails.getById(started.email.id)) as EmailRecord,
        result.decision,
        { repos: world.repos, clock, logger },
      );

      if (result.decision.plan.requiresApproval && !refused.ok) approvalPolicyPreserved++;
      else detail.push('POLICY FLOOR BREACHED: a settings change weakened a revision');
    }
    await world.close();
  }

  // --- 3. Unsafe human edits ----------------------------------------------
  //
  // One attempt per guardrail. A human may rewrite the reply; they may not
  // rewrite it into something the model would have been stopped from saying.
  const unsafeDrafts: Array<[string, string]> = [
    ['no_price_commitment', 'Our price is $2,000 for this.'],
    ['no_delivery_promise', 'We will deliver it within 3 weeks.'],
    ['no_discount_or_offer', 'I can offer you a free audit to get started.'],
    ['no_legal_or_contractual_language', 'We guarantee this outcome and accept liability for it.'],
    ['no_pii_echo', 'Copying in my colleague at someone-else@unrelated.example.'],
    ['no_invented_facts', 'Our clients typically see a 312% increase in recovered carts.'],
  ];

  let unsafeEditAttempts = 0;
  let unsafeEditBlocked = 0;
  {
    const world = await createWorld(options, 'manual');
    const started = await pending(world, options, 'demo-e01');

    if (started && started.decision.plan.draft !== null) {
      const before = await crmCounts(world.repos);

      for (const [guardrail, sentence] of unsafeDrafts) {
        unsafeEditAttempts++;
        try {
          await reviseDecision(
            started.decision.id,
            { edits: { draft: { body: `Hi Sarah,\n\n${sentence}\n\nSameer` } }, editedBy: 'sameer' },
            { repos: world.repos, clock, logger },
          );
          detail.push(`UNSAFE EDIT ACCEPTED: ${guardrail}`);
        } catch {
          // Refused, as it must be. The revision must also have left nothing.
          const decisions = await world.repos.decisions.listForEmail(started.email.id);
          const untouched = JSON.stringify(await crmCounts(world.repos)) === JSON.stringify(before);
          const stillPending =
            (await world.repos.approvals.getForDecision(started.decision.id))?.state === 'pending';

          if (decisions.length === 1 && untouched && stillPending) unsafeEditBlocked++;
          else detail.push(`UNSAFE EDIT LEFT RESIDUE: ${guardrail}`);
        }
      }

      // Every refusal is on the record, and none of them carries the text.
      const blockedEvents = (await world.repos.audit.listByEmail(started.email.id)).filter(
        (event) => event.eventType === 'draft_edit_blocked',
      );
      if (blockedEvents.length !== unsafeEditAttempts) {
        auditIntegrity = false;
        detail.push(`AUDIT: ${blockedEvents.length} draft_edit_blocked for ${unsafeEditAttempts} attempts`);
      }
      const serialised = JSON.stringify(blockedEvents);
      if (unsafeDrafts.some(([, sentence]) => serialised.includes(sentence.slice(0, 20)))) {
        auditIntegrity = false;
        detail.push('AUDIT: a blocked edit stored the offending text');
      }
    }
    await world.close();
  }

  // --- 4. Atomicity --------------------------------------------------------
  let rollbackAttempts = 0;
  let atomicRollback = 0;
  {
    const world = await createWorld(options, 'manual');
    const started = await pending(world, options, 'demo-e01');

    if (started) {
      rollbackAttempts++;
      const faulty = createRepositories(failingOn(world.db, /INSERT INTO audit_events/i), {
        clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
        newId: createSequentialIds('faulty'),
      });
      const approvalsBefore = await world.repos.approvals.count();

      try {
        await reviseDecision(
          started.decision.id,
          { edits: { draft: { subject: 'A calmer subject line' } }, editedBy: 'sameer' },
          { repos: faulty, clock, logger },
        );
        detail.push('ROLLBACK: a failed revision was committed anyway');
      } catch {
        const decisions = await world.repos.decisions.listForEmail(started.email.id);
        const v1 = await world.repos.decisions.getById(started.decision.id);
        const events = await world.repos.audit.listByEmail(started.email.id);

        const clean =
          decisions.length === 1 &&
          v1?.supersededBy === null &&
          (await world.repos.approvals.getForDecision(started.decision.id))?.state === 'pending' &&
          (await world.repos.approvals.count()) === approvalsBefore &&
          events.filter((event) => event.eventType === 'plan_revised').length === 0 &&
          events.filter((event) => event.eventType === 'approval_superseded').length === 0;

        if (clean) atomicRollback++;
        else detail.push('ROLLBACK: a failed revision left something behind');
      }
    }
    await world.close();
  }

  // --- 5. Expiry -----------------------------------------------------------
  let expiryAttempts = 0;
  let expiredRevisionNotExecutable = 0;
  {
    const world = await createWorld(options, 'manual');
    const started = await pending(world, options, 'demo-e01');

    if (started) {
      expiryAttempts++;
      const result = await reviseDecision(
        started.decision.id,
        { edits: { draft: { subject: 'A calmer subject line' } }, editedBy: 'sameer' },
        { repos: world.repos, clock, logger },
      );

      await world.db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
        '2020-01-01T00:00:00.000Z',
        result.decision.id,
      ]);

      const swept = await sweepExpiredApprovals({ repos: world.repos, clock, logger, limit: 50 });
      const email = await world.repos.emails.getById(started.email.id);
      const before = await crmCounts(world.repos);

      // Force an executable state so the approval check, not the state guard,
      // is what has to refuse.
      await world.repos.emails.setState(started.email.id, 'awaiting_approval');
      const attempt = await executePlan(
        (await world.repos.emails.getById(started.email.id)) as EmailRecord,
        result.decision,
        { repos: world.repos, clock, logger },
      );

      const expiredState = (await world.repos.approvals.getForDecision(result.decision.id))?.state;
      const unchanged = JSON.stringify(await crmCounts(world.repos)) === JSON.stringify(before);

      if (swept.expired.length === 1 && expiredState === 'expired' && email?.state === 'needs_review' && !attempt.ok && unchanged) {
        expiredRevisionNotExecutable++;
      } else {
        detail.push(
          `EXPIRY: swept=${swept.expired.length} state=${expiredState} email=${email?.state} ran=${attempt.ok}`,
        );
      }
    }
    await world.close();
  }

  return {
    metrics: {
      revisionAttempts,
      revisionSuccess,
      originalPreserved,
      supersededCorrectly,
      newApprovalPending,
      fingerprintChanged,
      policyAttempts,
      approvalPolicyPreserved,
      unsafeEditAttempts,
      unsafeEditBlocked,
      rollbackAttempts,
      atomicRollback,
      executableOnlyAfterApproval,
      duplicateSideEffects,
      expiryAttempts,
      expiredRevisionNotExecutable,
      auditIntegrity,
      outboxSent,
    },
    detail,
  };
}

/**
 * The thresholds.
 *
 * Every one of them is paired with an attempt count, because the failure mode
 * this evaluation is most likely to have is not "a property broke" but "the
 * property was never tested and reported a perfect score".
 */
export function reviseThresholdFailures(metrics: ReviseReport['metrics']): string[] {
  const failures: string[] = [];

  if (metrics.revisionAttempts < 3) failures.push(`only ${metrics.revisionAttempts} revision(s) attempted; too few to prove anything`);
  if (metrics.revisionSuccess !== metrics.revisionAttempts) {
    failures.push(`${metrics.revisionAttempts - metrics.revisionSuccess} revision(s) failed unexpectedly`);
  }
  for (const [name, value] of [
    ['originalPreserved', metrics.originalPreserved],
    ['supersededCorrectly', metrics.supersededCorrectly],
    ['newApprovalPending', metrics.newApprovalPending],
    ['fingerprintChanged', metrics.fingerprintChanged],
    ['executableOnlyAfterApproval', metrics.executableOnlyAfterApproval],
  ] as const) {
    if (value !== metrics.revisionSuccess) {
      failures.push(`${name} ${value}/${metrics.revisionSuccess} — must hold for every revision`);
    }
  }

  if (metrics.duplicateSideEffects > 0) failures.push(`${metrics.duplicateSideEffects} duplicate side effect(s)`);
  if (metrics.outboxSent > 0) failures.push(`${metrics.outboxSent} message(s) marked sent — nothing may ever be sent`);
  if (!metrics.auditIntegrity) failures.push('the audit trail is not exactly one event per step');

  if (metrics.policyAttempts === 0) failures.push('the approval floor was never exercised');
  else if (metrics.approvalPolicyPreserved !== metrics.policyAttempts) failures.push('a settings change weakened a revision');

  if (metrics.unsafeEditAttempts < 6) failures.push(`only ${metrics.unsafeEditAttempts} unsafe edit(s) attempted; all six guardrails must be tried`);
  else if (metrics.unsafeEditBlocked !== metrics.unsafeEditAttempts) {
    failures.push(`${metrics.unsafeEditAttempts - metrics.unsafeEditBlocked} unsafe edit(s) were not fully blocked`);
  }

  if (metrics.rollbackAttempts === 0) failures.push('rollback was never exercised');
  else if (metrics.atomicRollback !== metrics.rollbackAttempts) failures.push('a failed revision left something behind');

  if (metrics.expiryAttempts === 0) failures.push('expiry was never exercised');
  else if (metrics.expiredRevisionNotExecutable !== metrics.expiryAttempts) {
    failures.push('an expired revision did not behave correctly');
  }

  return failures;
}
