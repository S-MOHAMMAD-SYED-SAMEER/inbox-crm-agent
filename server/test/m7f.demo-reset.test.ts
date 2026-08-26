import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, DEMO_DATA_DIR } from './helpers.ts';
import { assessDemoReset, computeIdentity, verifyPristine } from '../src/demo/reset.ts';
import { clearAllData, readSeedFile, seedDemoData } from '../src/db/seed.ts';
import type { Database } from '../src/db/types.ts';

// M7-F — the guards on the demo reset.
//
// This is the only mechanism in the project permitted to delete rows from a
// hosted database, so every refusal it can make is asserted here. A guard with
// no test is a guard that quietly stops working.
//
// The tests run against in-memory SQLite. That is not a limitation: the
// decisions under test are about declared intent, pinned identity and the
// recognisability of rows — none of which depend on the driver.

const seedFile = readSeedFile(DEMO_DATA_DIR);
const SEED_COUNTS: Record<string, number> = {
  companies: seedFile.companies.length,
  contacts: seedFile.contacts.length,
  deals: seedFile.deals.length,
  tasks: seedFile.tasks.length,
  activities: seedFile.activities.length,
  notes: seedFile.notes.length,
};

// Every connection string below is synthetic: the reserved `.example.test`
// domain, a placeholder role and a placeholder password. Earlier drafts used
// the real Neon role name and host suffix as "obviously fake" values, which a
// secret scan correctly flagged. A scan that gets routinely overridden stops
// being a scan.
const DEMO_IDS = ['demo-e01', 'demo-e02', 'demo-e03', 'demo-e04', 'demo-e05'];

const base = {
  driver: 'sqlite',
  declaredKind: 'local' as const,
  identity: null,
  expectedIdentity: null,
  demoMessageIds: DEMO_IDS,
  seedCounts: SEED_COUNTS,
};

/** An email row, written directly so a probe can control provider and id. */
async function insertEmail(db: Database, provider: string, messageId: string): Promise<void> {
  await db.execute(
    'INSERT INTO emails (id, correlation_id, provider, provider_message_id, from_email, to_email, subject, body_text, received_at, ingested_at, state) ' +
      "VALUES (?, ?, ?, ?, 'a@b.com', 'me@x.co', 's', 'b', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'received')",
    [crypto.randomUUID(), crypto.randomUUID(), provider, messageId],
  );
}

/** A company row, written directly so a probe can control `source`. */
async function insertCompany(db: Database, name: string, source: string): Promise<void> {
  await db.execute(
    'INSERT INTO companies (id, name, name_norm, domain, source, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
    [crypto.randomUUID(), name, name.toLowerCase(), `${name.toLowerCase().replace(/\s+/g, '')}.example`, source],
  );
}

// ============================================================ identity

test('the identity fingerprint excludes credentials and is stable', () => {
  const a = computeIdentity('postgresql://someone:placeholder@db.example.test/appdb');
  const b = computeIdentity('postgresql://someone:placeholder@db.example.test/appdb');
  assert.equal(a, b, 'the same target produced two different fingerprints');
  assert.equal(a.length, 16);

  // The password must not influence it — otherwise rotating a password would
  // silently unpin the target and every reset would start refusing.
  const rotated = computeIdentity('postgresql://someone:different-placeholder@db.example.test/appdb');
  assert.equal(a, rotated, 'the fingerprint changed when only the password changed');

  // Nothing recoverable leaks into it.
  assert.ok(!a.includes('placeholder'));
  assert.ok(!a.includes('example'));
});

test('different databases produce different fingerprints', () => {
  const demo = computeIdentity('postgresql://someone:placeholder@ep-demo.example.test/appdb');
  const other = computeIdentity('postgresql://someone:placeholder@ep-verify.example.test/appdb');
  assert.notEqual(demo, other, 'two different hosts share a fingerprint');

  const sameHostOtherDb = computeIdentity('postgresql://someone:placeholder@ep-demo.example.test/otherdb');
  assert.notEqual(demo, sameHostOtherDb, 'two databases on one host share a fingerprint');
});

test('a malformed connection string still produces a comparable fingerprint', () => {
  // It must fail the comparison, not crash before reaching it.
  const value = computeIdentity('not a url at all');
  assert.equal(value.length, 16);
});

// ================================================== declaring the target

test('a reset with no declared target is refused', async () => {
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, { ...base, declaredKind: null });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'no_target_declared');
  await close();
});

test('asking for production while connected to SQLite is refused', async () => {
  // The dangerous direction: someone means the deployed demo, and a missing
  // DATABASE_URL has quietly left them on the local file. Refuse rather than
  // reset the wrong thing — and never the other way round either.
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, { ...base, declaredKind: 'production', driver: 'sqlite' });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'driver_mismatch');
  assert.match(result.ok === false ? result.message : '', /silently fall back/i);
  await close();
});

test('asking for local while connected to a hosted database is refused', async () => {
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, { ...base, declaredKind: 'local', driver: 'postgres' });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'driver_mismatch');
  await close();
});

// ======================================================= pinned identity

test('a hosted reset with no pinned identity is refused', async () => {
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, {
    ...base,
    driver: 'postgres',
    declaredKind: 'production',
    identity: computeIdentity('postgresql://someone:placeholder@ep-demo.example.test/appdb'),
    expectedIdentity: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'identity_not_pinned');
  await close();
});

test('a hosted reset against the wrong database is refused', async () => {
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, {
    ...base,
    driver: 'postgres',
    declaredKind: 'production',
    identity: computeIdentity('postgresql://someone:placeholder@ep-elsewhere.example.test/appdb'),
    expectedIdentity: computeIdentity('postgresql://someone:placeholder@ep-demo.example.test/appdb'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'identity_mismatch');
  await close();
});

test('THE ONE THAT MATTERS — the M5-E verification branch cannot be reset', async () => {
  // M5-E and the demo are two branches of the same Neon project: same database
  // name, same region, different endpoint. Only the endpoint distinguishes
  // them, so this asserts that the endpoint alone is enough.
  const demo = 'postgresql://someone:placeholder@ep-demo-aaaa.region.example.test/appdb';
  const m5e = 'postgresql://someone:placeholder@ep-verify-bbbb.region.example.test/appdb';

  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, {
    ...base,
    driver: 'postgres',
    declaredKind: 'production',
    identity: computeIdentity(m5e), // DATABASE_URL is pointing at M5-E
    expectedIdentity: computeIdentity(demo), // but the demo is what was pinned
  });

  assert.equal(result.ok, false, 'the M5-E branch was accepted as a reset target');
  assert.equal(result.ok === false && result.code, 'identity_mismatch');
  await close();
});

test('a hosted reset against the pinned database is allowed', async () => {
  // The positive control. Without it, every refusal above could be passing
  // because nothing is ever allowed.
  const url = 'postgresql://someone:placeholder@ep-demo.example.test/appdb';
  const { db, close } = await createTestContext();
  const result = await assessDemoReset(db, {
    ...base,
    driver: 'postgres',
    declaredKind: 'production',
    identity: computeIdentity(url),
    expectedIdentity: computeIdentity(url),
  });

  assert.equal(result.ok, true, result.ok === false ? result.message : '');
  await close();
});

// ================================================ recognising demo data

test('an email from outside the fixture aborts the reset', async () => {
  const { db, close } = await createTestContext();
  await insertEmail(db, 'demo', 'demo-e01');
  await insertEmail(db, 'demo', 'not-a-fixture-id');

  const result = await assessDemoReset(db, base);
  assert.equal(result.ok, false, 'an unknown message id was accepted as demo data');
  assert.equal(result.ok === false && result.code, 'unrecognised_email');
  await close();
});

test('an email from a real provider aborts the reset', async () => {
  // The scenario this exists for: someone connected a live mailbox. Those are
  // somebody's actual messages and this must not delete them.
  const { db, close } = await createTestContext();
  await insertEmail(db, 'gmail', 'demo-e01');

  const result = await assessDemoReset(db, base);
  assert.equal(result.ok, false, 'a real mailbox was accepted as demo data');
  assert.equal(result.ok === false && result.code, 'unrecognised_email');
  await close();
});

test('a CRM record that is neither seeded nor agent-created aborts the reset', async () => {
  const { repos, db, close } = await createTestContext();
  await seedDemoData(repos, seedFile);

  await insertCompany(db, 'Real Client Ltd', 'human');

  const result = await assessDemoReset(db, base);
  assert.equal(result.ok, false, 'a human-created record was accepted as demo data');
  assert.equal(result.ok === false && result.code, 'unrecognised_crm_source');
  await close();
});

test('seeded and agent-created records are both recognised', async () => {
  const { repos, db, close } = await createTestContext();
  await seedDemoData(repos, seedFile);
  await insertCompany(db, 'Acme Commerce', 'agent');
  await insertEmail(db, 'demo', 'demo-e03');

  const result = await assessDemoReset(db, base);
  assert.equal(result.ok, true, result.ok === false ? result.message : '');
  assert.ok(result.ok === true && result.willDelete.emails === 1);
  assert.ok(result.ok === true && (result.willDelete.companies ?? 0) > (SEED_COUNTS.companies ?? 0));
  await close();
});

// ================================================= the resulting state

test('after a reset the database matches the pristine demo state', async () => {
  const { repos, db, close } = await createTestContext();

  // Put it in the state a finished demonstration leaves behind.
  await seedDemoData(repos, seedFile);
  await insertEmail(db, 'demo', 'demo-e01');
  await insertCompany(db, 'Agent Made', 'agent');

  const before = await verifyPristine(db, SEED_COUNTS, 5);
  assert.equal(before.pristine, false, 'PRECONDITION: a used demo must not already look pristine');

  await clearAllData(repos);
  await seedDemoData(repos, seedFile);

  const after = await verifyPristine(db, SEED_COUNTS, 5);
  assert.equal(after.pristine, true, after.problems.join('; '));

  // The specific things the walkthrough depends on.
  assert.equal(after.counts.emails, 0, 'the inbox must be empty so the demo can ingest live');
  assert.equal(after.counts.decisions, 0);
  assert.equal(after.counts.approvals, 0);
  assert.equal(after.counts.audit_events, 0);
  assert.equal(after.counts.outbox_messages, 0);
  assert.equal(after.counts.sessions, 0);
  assert.equal(after.counts.companies, SEED_COUNTS.companies);
  assert.equal(after.counts.settings, 5);

  await close();
});

test('verifyPristine reports each shortfall rather than a bare false', async () => {
  const { repos, db, close } = await createTestContext();
  await seedDemoData(repos, seedFile);
  await insertEmail(db, 'demo', 'demo-e01');

  const check = await verifyPristine(db, SEED_COUNTS, 5);
  assert.equal(check.pristine, false);
  assert.ok(
    check.problems.some((problem) => problem.includes('emails')),
    `the email row was not reported: ${check.problems.join('; ')}`,
  );
  await close();
});
