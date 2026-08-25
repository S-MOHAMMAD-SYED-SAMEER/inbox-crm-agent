import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR } from './helpers.ts';
import {
  EMAIL_STATES,
  REVIEW_REASONS,
  EMAIL_CATEGORIES,
  PRIORITIES,
  CONFIDENCE_BANDS,
  EMAIL_PROVIDERS,
} from '../src/domain/email.ts';
import {
  DEAL_STAGES,
  SERVICE_LINES,
  CONTACT_LIFECYCLES,
  TASK_STATUSES,
  ACTIVITY_TYPES,
  ACTIVITY_DIRECTIONS,
  RECORD_SOURCES,
} from '../src/domain/crm.ts';
import { AUDIT_STAGES, AUDIT_ACTORS, AUDIT_OUTCOMES } from '../src/domain/audit.ts';
import { APPROVAL_STATES } from '../src/domain/execution.ts';
import { DECISION_ORIGINS } from '../src/domain/decision.ts';

// Schema/type parity.
//
// The domain enums in src/domain/*.ts and the CHECK constraints in the
// migrations are two statements of the same fact, and two statements of the
// same fact drift. This test parses the actual SQL and compares them.
//
// The drift it prevents is not hypothetical: adding a category to a TypeScript
// union without adding it to the CHECK constraint produces code that
// typechecks, passes every unit test, and then fails at the database on the one
// input that uses the new value. The reverse — a value legal in the database
// that no TypeScript type admits — is just as bad and just as invisible.
//
// Lookups are scoped per table because column names repeat: `stage` means one
// thing on `deals` and another on `audit_events`, and `status` means three
// different things across the schema.

const sql = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
  .join('\n');

/**
 * The name a table's definition actually lives under.
 *
 * A CHECK constraint cannot be altered in SQLite, so changing one means
 * rebuilding the table: create it under a temporary name, copy, drop, rename
 * (migration 008). After that the definition in force is the one written for
 * the temporary name, while the original `CREATE TABLE` still sits earlier in
 * the migration history saying something out of date.
 *
 * Following the rename is the difference between this test checking the live
 * schema and checking a fossil — which would be worse than not checking, since
 * it would report parity while the running database disagreed.
 */
function definitionName(table: string): string {
  let name = table;
  for (const match of sql.matchAll(new RegExp(`ALTER TABLE\\s+(\\w+)\\s+RENAME TO\\s+${table}\\b`, 'gi'))) {
    name = match[1] as string;
  }
  return name;
}

/**
 * Everything the migrations say about a table's columns.
 *
 * The `CREATE TABLE` body plus every `ADD COLUMN` that follows it, because a
 * column added by a later migration carries its constraints in the ALTER rather
 * than in the original definition — `decisions.origin` (008) is one. Only
 * alters *after* the definition count: a rebuild folds the earlier ones into
 * its new `CREATE TABLE`, so replaying them would resurrect a constraint the
 * rebuild had replaced.
 */
function tableDdl(table: string): string {
  const resolved = definitionName(table);
  const pattern = new RegExp(`CREATE TABLE ${resolved}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
  const match = pattern.exec(sql);
  assert.ok(match, `no CREATE TABLE found for "${resolved}"`);

  const definedAt = match.index;
  const alters = [...sql.matchAll(new RegExp(`ALTER TABLE\\s+(?:${table}|${resolved})\\s+ADD COLUMN([^;]*);`, 'gi'))]
    .filter((alter) => (alter.index ?? 0) > definedAt)
    .map((alter) => alter[1] as string);

  return [match[1] as string, ...alters].join('\n');
}

function checkValues(table: string, column: string): string[] {
  const ddl = tableDdl(table);
  const pattern = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const match = pattern.exec(ddl);
  assert.ok(match, `no CHECK constraint found for ${table}.${column}`);
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

function assertParity(table: string, column: string, values: readonly string[]): void {
  assert.deepEqual(
    [...checkValues(table, column)].sort(),
    [...values].sort(),
    `${table}.${column} and its TypeScript union have drifted apart`,
  );
}

test('email workflow enums match their CHECK constraints', () => {
  assertParity('emails', 'state', EMAIL_STATES);
  assertParity('emails', 'review_reason', REVIEW_REASONS);
  assertParity('emails', 'provider', EMAIL_PROVIDERS);
  assertParity('email_analyses', 'category', EMAIL_CATEGORIES);
  assertParity('email_analyses', 'priority', PRIORITIES);
  assertParity('email_analyses', 'confidence_band', CONFIDENCE_BANDS);
});

test('CRM enums match their CHECK constraints', () => {
  assertParity('deals', 'stage', DEAL_STAGES);
  assertParity('deals', 'service_line', SERVICE_LINES);
  assertParity('contacts', 'lifecycle', CONTACT_LIFECYCLES);
  assertParity('tasks', 'status', TASK_STATUSES);
  assertParity('tasks', 'priority', PRIORITIES);
  assertParity('activities', 'type', ACTIVITY_TYPES);
  assertParity('activities', 'direction', ACTIVITY_DIRECTIONS);
});

test('every CRM table constrains `source` to the same three values', () => {
  for (const table of ['companies', 'contacts', 'deals', 'tasks', 'activities', 'notes']) {
    assertParity(table, 'source', RECORD_SOURCES);
  }
});

test('approval and decision enums match their CHECK constraints', () => {
  // M4-C: `approvals.state` gained a fifth value through a table rebuild, and
  // this is the pair most able to drift — the TypeScript union is read by the
  // queue, the expiry sweep and the executor, while the CHECK is what the
  // database will actually accept.
  assertParity('approvals', 'state', APPROVAL_STATES);
  assertParity('decisions', 'origin', DECISION_ORIGINS);
});

test('audit enums match their CHECK constraints', () => {
  assertParity('audit_events', 'stage', AUDIT_STAGES);
  assertParity('audit_events', 'actor', AUDIT_ACTORS);
  assertParity('audit_events', 'outcome', AUDIT_OUTCOMES);
});

test('the risk tiers accepted by the schema match the domain', () => {
  const match = /CHECK\s*\(\s*risk_tier\s+IN\s*\(([^)]*)\)/i.exec(tableDdl('decisions'));
  assert.ok(match);
  assert.deepEqual(
    (match[1] as string).split(',').map((value) => Number(value.trim())),
    [0, 1, 2],
    'risk tiers are 0, 1, 2 — a tier 3 would mean the approval policy has an unhandled case',
  );
});

test('every CRM table carries deleted_at, since reads filter on it', () => {
  // Spec §11 requires soft delete; §10 omitted the column. If a table gains a
  // repository read that filters `deleted_at IS NULL` while the migration never
  // added the column, every read against it fails at runtime.
  for (const table of ['companies', 'contacts', 'deals', 'tasks', 'activities', 'notes']) {
    assert.match(tableDdl(table), /deleted_at\s+TIMESTAMPTZ/i, `${table} is missing deleted_at`);
  }
});
