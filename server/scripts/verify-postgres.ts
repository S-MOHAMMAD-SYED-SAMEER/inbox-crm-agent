import { loadConfig } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createSequentialIds, deterministicId } from '../src/lib/ids.ts';
import { readSeedFile, seedDemoData, clearAllData } from '../src/db/seed.ts';
import { hashPassword } from '../src/lib/password.ts';
import { hashSessionToken } from '../src/domain/session.ts';
import { planFingerprint } from '../src/domain/execution.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, SqlParam } from '../src/db/types.ts';

// M5-E — targeted PostgreSQL verification.
//
// The 624-test suite cannot run here: `createTestDatabase()` is in-memory
// SQLite, and every `createTestContext()` assumes a private database. Giving
// ~200 contexts their own Postgres schema plus ten migrations over a network is
// not a practical run. So this exercises the same repositories and the same code
// paths against the real server, and the report says exactly what that covers.
//
// TWO LESSONS LEARNED WRITING THIS FILE, recorded because they are the same
// class of mistake this milestone exists to catch:
//
//   1. Synthetic ids must be real UUIDs. Postgres enforces the schema's UUID
//      columns; SQLite maps them to TEXT and accepts anything.
//   2. A constraint probe against an EMPTY table proves nothing — `UPDATE t SET
//      col='bogus'` on zero rows succeeds silently. Every probe below runs
//      against a row that exists, and there is a precondition check saying so.

/** Every synthetic id must be a real UUID: Postgres enforces the column type. */
const uid = (name: string) => deterministicId(`m5e:${name}`);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo');

const config = loadConfig(process.env).config;
if (config.dbDriver !== 'postgres') {
  console.error('This script verifies PostgreSQL. Set DATABASE_URL to a postgres:// URL.');
  console.error('Run it as: node --env-file=<path-to-.env> scripts/verify-postgres.ts');
  process.exit(1);
}
const db: Database = await createDatabase(config);
const clock = createFixedClock('2026-06-01T00:00:00.000Z', 1000);
const repos = createRepositories(db, { clock, newId: createSequentialIds('pgrun') });

const exec = (sql: string, p: SqlParam[] = []) => db.execute(sql, p);
const query = (sql: string, p: SqlParam[] = []) => db.query(sql, p);

const EMAIL = uid('email');
const CORR = uid('correlation');
const ANALYSIS = uid('analysis');

async function makeEmailAndAnalysis(): Promise<void> {
  await exec(
    'INSERT INTO emails (id, correlation_id, provider, provider_message_id, from_email, to_email, subject, body_text, received_at, ingested_at, state) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      EMAIL, CORR, 'demo', 'm5e-pm-1', 'sarah@acme.example', 'me@x.co',
      'Enquiry', 'Body text', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'awaiting_approval',
    ],
  );
  await exec(
    'INSERT INTO email_analyses (id, email_id, category, intent, priority, priority_reason, confidence, confidence_band, extracted, summary, model, prompt_version, latency_ms, created_at) ' +
      "VALUES (?, ?, 'sales_inquiry', 'i', 'high', 'r', 0.9, 'high', '{}', 's', 'mock', 'v1', 1, '2026-06-01T00:00:00.000Z')",
    [ANALYSIS, EMAIL],
  );
}

function plan(subject: string) {
  return {
    actions: [{ type: 'send_email' as const, payload: { toEmail: 'sarah@acme.example' } }],
    riskTier: 2 as const,
    requiresApproval: true,
    approvalReasons: [{ code: 'consequential_action' as const, message: 'sends a reply' }],
    rationale: 'test',
    ruleTrace: [],
    draft: { subject, body: 'Hello.', guardrailsPassed: [], blockedBy: [] },
    draftFailedReason: null,
  };
}

// ==================================================================== SEED
console.log('\n=== SEED ===');
{
  const counts = {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };
  check(
    'seed produced the documented demo dataset',
    counts.companies === 6 && counts.contacts === 9 && counts.deals === 4 && counts.tasks === 5,
    JSON.stringify(counts),
  );

  const again = await seedDemoData(repos, readSeedFile(DEMO_DIR));
  check('re-seeding is a no-op', again.companies === 0 && again.skipped === 47, `skipped=${again.skipped}`);
}

// ============================================================= CONSTRAINTS
//
// Re-runnable by construction: this script owns a fixed set of derived ids, so
// it clears its own fixtures before creating them rather than colliding with a
// previous run. A verification tool you can only run once is not one anybody
// runs twice.
async function clearOwnFixtures(): Promise<void> {
  await exec('DELETE FROM audit_events WHERE correlation_id = ?', [CORR]);
  await exec('DELETE FROM outbox_messages WHERE email_id = ?', [EMAIL]);
  await exec('DELETE FROM approvals WHERE decision_id IN (SELECT id FROM decisions WHERE email_id = ?)', [EMAIL]);
  await exec('UPDATE decisions SET superseded_by = NULL, parent_decision_id = NULL WHERE email_id = ?', [EMAIL]);
  await exec('DELETE FROM action_executions WHERE decision_id IN (SELECT id FROM decisions WHERE email_id = ?)', [EMAIL]);
  await exec('DELETE FROM decisions WHERE email_id = ?', [EMAIL]);
  await exec('DELETE FROM email_analyses WHERE email_id = ?', [EMAIL]);
  await exec('DELETE FROM entity_matches WHERE email_id = ?', [EMAIL]);
  await exec('DELETE FROM emails WHERE id = ? OR provider_message_id = ?', [EMAIL, 'm5e-pm-1']);
  await exec('DELETE FROM sessions WHERE operator = ?', ['operator']);
}

console.log('\n=== CONSTRAINTS (against rows that exist) ===');
await clearOwnFixtures();
await makeEmailAndAnalysis();
const decision = await repos.decisions.create({
  emailId: EMAIL, analysisId: ANALYSIS, resolutionRun: null,
  plan: plan('Re: Enquiry'), model: null, promptVersion: null, latencyMs: null,
});
await repos.approvals.request(decision.id, 24);

{
  const emails = await query('SELECT id FROM emails');
  const approvals = await query('SELECT id FROM approvals');
  check(
    'PRECONDITION: rows exist, so these probes cannot pass vacuously',
    emails.length > 0 && approvals.length > 0,
    `emails=${emails.length} approvals=${approvals.length}`,
  );

  const dupeEmail = await rejects(() =>
    exec(
      'INSERT INTO emails (id, correlation_id, provider, provider_message_id, from_email, to_email, subject, body_text, received_at, ingested_at, state) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uid('dupe'), CORR, 'demo', 'm5e-pm-1', 'a@b.co', 'me@x.co',
        's', 'b', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'received',
      ],
    ),
  );
  check('UNIQUE(provider, provider_message_id) enforced', dupeEmail !== null && /unique|duplicate/i.test(dupeEmail.message), dupeEmail?.message.slice(0, 60));

  const fk = await rejects(() =>
    exec('INSERT INTO approvals (id, decision_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
      uid('fk-probe'), uid('no-such-decision'), 'pending', '2026-07-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
    ]),
  );
  check('FOREIGN KEY enforced', fk !== null && /foreign key|violates/i.test(fk.message));

  const dupeApproval = await rejects(() =>
    exec('INSERT INTO approvals (id, decision_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
      uid('dupe-approval'), decision.id, 'pending', '2026-07-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
    ]),
  );
  check('UNIQUE(decision_id) blocks a second approval', dupeApproval !== null && /unique|duplicate/i.test(dupeApproval.message));

  const badState = await rejects(() => exec('UPDATE approvals SET state = ? WHERE decision_id = ?', ['bogus', decision.id]));
  check('CHECK on approvals.state enforced (008 rebuild)', badState !== null && /check|violates/i.test(badState.message));

  const goodState = await rejects(() => exec('UPDATE approvals SET state = ? WHERE decision_id = ?', ['superseded', decision.id]));
  check("CHECK accepts 'superseded', the value 008 added", goodState === null);
  await exec('UPDATE approvals SET state = ? WHERE decision_id = ?', ['pending', decision.id]);

  const badOrigin = await rejects(() => exec('UPDATE decisions SET origin = ? WHERE id = ?', ['nonsense', decision.id]));
  check('CHECK on decisions.origin enforced (009-era column)', badOrigin !== null && /check|violates/i.test(badOrigin.message));

  const badTier = await rejects(() => exec('UPDATE decisions SET risk_tier = ? WHERE id = ?', [7, decision.id]));
  check('CHECK on decisions.risk_tier enforced', badTier !== null);

  const badEmailState = await rejects(() => exec('UPDATE emails SET state = ? WHERE id = ?', ['nonsense', EMAIL]));
  check('CHECK on emails.state enforced', badEmailState !== null);

  const badOutboxStatus = await rejects(() =>
    exec('INSERT INTO outbox_messages (id, email_id, decision_id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      uid('ob-bad'), EMAIL, decision.id, 'a@b.co', 's', 'b', 'not-a-status', '2026-06-01T00:00:00.000Z',
    ]),
  );
  check('CHECK on outbox_messages.status enforced (010 rebuild)', badOutboxStatus !== null && /check|violates/i.test(badOutboxStatus.message));

  const goodSending = await rejects(() =>
    exec('INSERT INTO outbox_messages (id, email_id, decision_id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      uid('ob-sending'), EMAIL, decision.id, 'a@b.co', 's', 'b', 'sending', '2026-06-01T00:00:00.000Z',
    ]),
  );
  check("CHECK accepts 'sending', the value 010 added", goodSending === null);
  await exec('DELETE FROM outbox_messages WHERE id = ?', [uid('ob-sending')]);
}

// ============================================================ TRANSACTIONS
console.log('\n=== TRANSACTIONS ===');
{
  const before = await repos.companies.count();

  const err = await rejects(() =>
    repos.transaction(async (tx) => {
      await tx.companies.create({
        id: uid('tx-rollback'), name: 'Should Not Survive', domain: null, website: null,
        industry: null, sizeBand: null, country: null, source: 'seed',
      });
      const mid = await tx.companies.count();
      if (mid !== before + 1) throw new Error(`expected ${before + 1} inside tx, saw ${mid}`);
      throw new Error('deliberate rollback');
    }),
  );

  check('the write was visible inside its own transaction', err !== null && /deliberate rollback/.test(err.message), err?.message.slice(0, 70));
  check('rollback removed it', (await repos.companies.count()) === before);
  check('the rolled-back row is gone by id', (await repos.companies.getById(uid('tx-rollback'))) === null);

  await repos.transaction(async (tx) => {
    await tx.companies.create({
      id: uid('tx-commit'), name: 'Should Survive', domain: null, website: null,
      industry: null, sizeBand: null, country: null, source: 'seed',
    });
  });
  check('commit persisted', (await repos.companies.getById(uid('tx-commit'))) !== null);
  await exec('DELETE FROM companies WHERE id = ?', [uid('tx-commit')]);

  const nested = await rejects(() =>
    repos.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.companies.create({
          id: uid('tx-nested'), name: 'Nested', domain: null, website: null,
          industry: null, sizeBand: null, country: null, source: 'seed',
        });
      });
      throw new Error('outer rollback');
    }),
  );
  check('a nested savepoint rolls back with its parent', nested !== null && (await repos.companies.getById(uid('tx-nested'))) === null);
}

// ==================================================== SEED TRANSACTION BINDING
console.log('\n=== SEED TRANSACTION BINDING (M4-D fix, on Postgres) ===');
{
  // The root handle refuses CRM inserts; transactions hand out an unrestricted
  // one. Before the M4-D fix the seed wrote through the root handle — on
  // Postgres that is a different pooled client, so this is exactly where it
  // would break. On SQLite the same test passes either way.
  const guarded: Database = {
    driver: db.driver,
    query: (sql, p) => db.query(sql, p),
    exec: (sql) => db.exec(sql),
    execute: (sql, p) =>
      /INSERT INTO (companies|contacts|deals|tasks|activities|notes)\b/i.test(sql)
        ? Promise.reject(new Error('a seed write escaped its transaction'))
        : db.execute(sql, p),
    transaction: (fn) => db.transaction(fn),
    close: () => Promise.resolve(),
  };

  await clearAllData(repos);
  const guardedRepos = createRepositories(guarded, { clock, newId: createSequentialIds('pgseed') });
  const seeded = await rejects(() => seedDemoData(guardedRepos, readSeedFile(DEMO_DIR)));
  check('the seed runs inside its transaction on Postgres', seeded === null, seeded?.message.slice(0, 70) ?? '');
  check('and wrote the full dataset', (await repos.companies.count()) === 6);
}

// ================================================ APPROVAL / REVISION LIFECYCLE
console.log('\n=== APPROVAL / REVISION ===');
await makeEmailAndAnalysis();
const v1 = await repos.decisions.create({
  emailId: EMAIL, analysisId: ANALYSIS, resolutionRun: null,
  plan: plan('Re: Enquiry'), model: null, promptVersion: null, latencyMs: null,
});
await repos.approvals.request(v1.id, 24);
let v2Id = '';
{
  check('a decision round-trips with revision provenance', v1.revision === 1 && v1.origin === 'agent');

  const snapshot = JSON.stringify((await repos.decisions.getById(v1.id))?.plan);
  const v2 = await repos.decisions.create({
    emailId: EMAIL, analysisId: ANALYSIS, resolutionRun: null,
    plan: plan('Re: Enquiry (edited)'), model: null, promptVersion: null, latencyMs: null,
    origin: 'human_edit', parentDecisionId: v1.id, editedBy: 'sameer',
  });
  v2Id = v2.id;
  await repos.approvals.decide(v1.id, 'superseded', { decidedBy: 'system' });

  check('v2 records parent and revision number', v2.revision === 2 && v2.parentDecisionId === v1.id);
  check('v1 is byte-identical after the revision', JSON.stringify((await repos.decisions.getById(v1.id))?.plan) === snapshot);
  check('v1 was superseded, not rewritten', (await repos.decisions.getById(v1.id))?.supersededBy === v2.id);
  check('v1 approval is superseded', (await repos.approvals.getForDecision(v1.id))?.state === 'superseded');

  const reSettle = await rejects(() => repos.approvals.decide(v1.id, 'approved', { decidedBy: 'attacker' }));
  check('a superseded approval cannot be approved', reSettle !== null && /already superseded/i.test(reSettle.message));

  await repos.approvals.request(v2.id, 24);
  await repos.approvals.decide(v2.id, 'approved', { decidedBy: 'sameer', planHash: planFingerprint(v2.plan) });
  check('v2 approval is bound to its own fingerprint', (await repos.approvals.getForDecision(v2.id))?.planHash === planFingerprint(v2.plan));

  const provenance = await rejects(() =>
    repos.decisions.create({
      emailId: EMAIL, analysisId: ANALYSIS, resolutionRun: null, plan: plan('x'),
      model: null, promptVersion: null, latencyMs: null,
      origin: 'human_edit', parentDecisionId: null, editedBy: 'sameer',
    }),
  );
  check('a human edit without a parent is refused', provenance !== null);
}

// ================================================================ OUTBOX CLAIM
console.log('\n=== OUTBOX CLAIM ===');
{
  const row = await repos.outbox.create({
    emailId: EMAIL, decisionId: v2Id, toEmail: 'sarah@acme.example',
    subject: 'Re: Enquiry', body: 'Hello.', status: 'queued', suppressedReason: null,
  });

  const first = await repos.outbox.claimForSending(row.id);
  check('a queued message can be claimed', first?.status === 'sending' && first.claimedAt !== null);
  check('a held claim cannot be taken again', (await repos.outbox.claimForSending(row.id)) === null);

  await repos.outbox.markSent(row.id, 'pg-provider-1');
  const sent = await repos.outbox.findForDecision(v2Id);
  check('markSent records delivery and clears the claim', sent?.status === 'sent' && sent.claimedAt === null && sent.sentAt !== null);
  check('a sent message can never be re-claimed', (await repos.outbox.claimForSending(row.id)) === null);
  check('recovery never touches a sent message', (await repos.outbox.recoverStaleSending(0, '2099-01-01T00:00:00.000Z')).length === 0);

  await exec('DELETE FROM outbox_messages WHERE id = ?', [row.id]);
}

// ============================================ TRUE CONCURRENCY — the point of M5-E
console.log('\n=== CONCURRENCY (real parallel connections) ===');
{
  for (const attempts of [2, 5, 10]) {
    const row = await repos.outbox.create({
      emailId: EMAIL, decisionId: v2Id, toEmail: 'sarah@acme.example',
      subject: 'Re: Enquiry', body: 'Hello.', status: 'queued', suppressedReason: null,
    });

    const results = await Promise.all(Array.from({ length: attempts }, () => repos.outbox.claimForSending(row.id)));
    const winners = results.filter((r) => r !== null);
    check(`${attempts} concurrent claims produce exactly one winner`, winners.length === 1, `winners=${winners.length}`);

    await exec('DELETE FROM outbox_messages WHERE id = ?', [row.id]);
  }

  // NEGATIVE CONTROL. Without the status condition every caller must win —
  // otherwise the checks above prove nothing about the claim itself.
  const row = await repos.outbox.create({
    emailId: EMAIL, decisionId: v2Id, toEmail: 'sarah@acme.example',
    subject: 'Re: Enquiry', body: 'Hello.', status: 'queued', suppressedReason: null,
  });
  const unguarded = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const r = await exec("UPDATE outbox_messages SET status = 'sending', claimed_at = ? WHERE id = ?", [
        '2026-06-01T00:00:00.000Z', row.id,
      ]);
      return r.rowCount;
    }),
  );
  const unguardedWinners = unguarded.filter((n) => n === 1).length;
  check(
    'NEGATIVE CONTROL: without the status condition every caller wins',
    unguardedWinners > 1,
    `winners=${unguardedWinners} — must exceed 1 or the concurrency checks are vacuous`,
  );
  await exec('DELETE FROM outbox_messages WHERE id = ?', [row.id]);

  // Concurrent approval settlement: the WHERE-clause guard must pick exactly one.
  for (let i = 0; i < 3; i++) {
    const d = await repos.decisions.create({
      emailId: EMAIL, analysisId: ANALYSIS, resolutionRun: null,
      plan: { ...plan('x'), actions: [], riskTier: 0 as const, draft: null },
      model: null, promptVersion: null, latencyMs: null,
    });
    await repos.approvals.request(d.id, 24);

    const outcomes = await Promise.allSettled([
      repos.approvals.decide(d.id, 'approved', { decidedBy: 'a' }),
      repos.approvals.decide(d.id, 'rejected', { decidedBy: 'b', reason: 'r' }),
      repos.approvals.decide(d.id, 'expired', { decidedBy: 'system' }),
    ]);
    const settled = outcomes.filter((o) => o.status === 'fulfilled').length;
    check('3 concurrent settlements of one approval yield exactly one winner', settled === 1, `settled=${settled}`);
  }
}

// ==================================================================== SESSIONS
console.log('\n=== SESSIONS ===');
{
  const { token, session } = await repos.sessions.create('operator', 12);
  check('a session persists', session.operator === 'operator' && session.csrfToken.length > 0);
  check('the stored value is the hash, not the token', session.tokenHash === hashSessionToken(token));
  check('a live session is found by its token', (await repos.sessions.findLive(token, '2026-06-01T00:00:10.000Z')) !== null);
  check('the stored hash cannot be replayed as a token', (await repos.sessions.findLive(session.tokenHash, '2026-06-01T00:00:10.000Z')) === null);
  check('an expired session is not found', (await repos.sessions.findLive(token, '2099-01-01T00:00:00.000Z')) === null);

  await repos.sessions.touch(session.tokenHash);
  check('activity does not extend the session', (await repos.sessions.findLive(token, '2026-06-01T00:00:20.000Z'))?.expiresAt === session.expiresAt);
  check('revoke removes it', (await repos.sessions.revoke(token)) === true);
  check('revoke is idempotent', (await repos.sessions.revoke(token)) === false);
  check('scrypt hashing works on this platform', (await hashPassword('a-long-enough-operator-password')).startsWith('scrypt$'));
}

// =========================================================== AGGREGATES + AUDIT
console.log('\n=== AGGREGATES + AUDIT ===');
{
  const counts = await repos.approvals.countByState();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check('countByState returns every state', Object.keys(counts).length === 5);
  check('countByState total matches count()', total === (await repos.approvals.count()), `${total}`);

  const event = await repos.audit.append({
    correlationId: CORR, emailId: EMAIL, stage: 'system', eventType: 'state_changed',
    actor: 'system', outcome: 'ok', summary: 'pg verification',
    payload: { decisionId: 'keep-whole', note: 'x'.repeat(20000) },
  });
  check('audit payload is bounded on Postgres', event.payload.payloadTruncated === true);
  check('identifiers survive the bound', event.payload.decisionId === 'keep-whole');

  const second = await repos.audit.append({
    correlationId: CORR, emailId: EMAIL, stage: 'system', eventType: 'state_changed',
    actor: 'system', outcome: 'ok', summary: 'second', payload: {},
  });
  check('audit sequence increments within a correlation', second.sequence > event.sequence);

  const dupeSeq = await rejects(() =>
    exec(
      'INSERT INTO audit_events (id, correlation_id, sequence, stage, event_type, actor, outcome, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uid('audit-dupe'), CORR, second.sequence, 'system', 'state_changed', 'system', 'ok', 's', '{}', '2026-06-01T00:00:00.000Z'],
    ),
  );
  check('UNIQUE(correlation_id, sequence) enforced', dupeSeq !== null && /unique|duplicate/i.test(dupeSeq.message));
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
await db.close();
if (failed > 0) process.exitCode = 1;
