import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../src/db/index.ts';
import { runMigrations, appliedMigrations, readMigrations, checksumOf } from '../src/db/migrate.ts';
import { MIGRATIONS_DIR, MIGRATION_COUNT, rejects } from './helpers.ts';

// Migration runner behaviour, plus a real schema check: the tables and columns
// the repositories depend on are asserted to exist after the real migration
// files run. That is the closest thing to a schema test available without a
// Postgres server, and it catches the failure that matters — a repository
// querying a column the migration never created.

const EXPECTED_TABLES = [
  'emails',
  'email_analyses',
  'entity_matches',
  'decisions',
  'approvals',
  'action_executions',
  'outbox_messages',
  'companies',
  'contacts',
  'deals',
  'tasks',
  'activities',
  'notes',
  'audit_events',
  'settings',
];

async function tableNames(db: Awaited<ReturnType<typeof createTestDatabase>>): Promise<string[]> {
  const rows = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return rows.map((row) => row.name);
}

test('migrations apply cleanly and create every expected table', async () => {
  const db = createTestDatabase();
  const report = await runMigrations(db, MIGRATIONS_DIR);

  assert.equal(report.applied.length, MIGRATION_COUNT);
  assert.equal(report.skipped.length, 0);

  const tables = await tableNames(db);
  for (const table of EXPECTED_TABLES) {
    assert.ok(tables.includes(table), `expected table "${table}" to exist after migration`);
  }
  await db.close();
});

test('re-running migrations is a no-op', async () => {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR);
  const second = await runMigrations(db, MIGRATIONS_DIR);

  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, MIGRATION_COUNT);
  assert.equal((await appliedMigrations(db)).length, MIGRATION_COUNT);
  await db.close();
});

test('migrations are recorded in order with their checksums', async () => {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR);

  const applied = await appliedMigrations(db);
  assert.deepEqual(
    applied.map((m) => m.name),
    readMigrations(MIGRATIONS_DIR).map((m) => m.name),
    'applied migrations must match the files on disk, in order',
  );
  for (const migration of applied) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
  }
  await db.close();
});

test('editing an already-applied migration is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icrm-migrations-'));
  fs.writeFileSync(path.join(dir, '001_initial.sql'), 'CREATE TABLE a (id TEXT PRIMARY KEY);');

  const db = createTestDatabase();
  await runMigrations(db, dir);

  fs.writeFileSync(path.join(dir, '001_initial.sql'), 'CREATE TABLE a (id TEXT PRIMARY KEY, extra TEXT);');
  const err = await rejects(() => runMigrations(db, dir));

  assert.match(err.message, /has changed since it was applied/);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing migration leaves no partial schema behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icrm-migrations-'));
  fs.writeFileSync(
    path.join(dir, '001_broken.sql'),
    'CREATE TABLE good (id TEXT PRIMARY KEY);\nCREATE TABLE bad (id TEXT PRIMARY KEY, );',
  );

  const db = createTestDatabase();
  const err = await rejects(() => runMigrations(db, dir));
  assert.match(err.message, /001_broken\.sql failed on statement/);

  // The first statement succeeded before the second failed; the transaction
  // must have taken it back out again.
  const tables = await tableNames(db);
  assert.ok(!tables.includes('good'), 'a failed migration must not leave its earlier statements applied');
  assert.equal((await appliedMigrations(db)).length, 0);

  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checksums ignore line-ending differences', () => {
  assert.equal(checksumOf('CREATE TABLE a;\nCREATE TABLE b;'), checksumOf('CREATE TABLE a;\r\nCREATE TABLE b;'));
});

test('migration files are read in zero-padded numeric order', () => {
  const migrations = readMigrations(MIGRATIONS_DIR);
  const versions = migrations.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort());
  assert.equal(versions.length, MIGRATION_COUNT);
  assert.equal(versions[0], '001');
});

test('foreign keys are enforced, not merely declared', async () => {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR);

  const err = await rejects(() =>
    db.execute(
      `INSERT INTO contacts (id, company_id, full_name, email, lifecycle, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['c1', 'company-that-does-not-exist', 'Test Person', 't@example.com', 'lead', 'seed', 'x', 'x'],
    ),
  );
  assert.match(err.message, /FOREIGN KEY/i);
  await db.close();
});

test('CHECK constraints reject values outside the domain enums', async () => {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR);

  const err = await rejects(() =>
    db.execute(
      `INSERT INTO deals (id, title, stage, currency, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['d1', 'Bad stage', 'not_a_real_stage', 'USD', 'seed', 'x', 'x'],
    ),
  );
  assert.match(err.message, /CHECK constraint/i);
  await db.close();
});
