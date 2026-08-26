import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestContext } from './helpers.ts';
import { toJson, fromJson } from '../src/db/rows.ts';
import { DEFAULT_SETTINGS } from '../src/db/repositories/settings.ts';

// M7-F — the driver divergence that broke production and nothing else.
//
// `node:sqlite` returns a JSON column as the text it stored. `pg` parsed JSONB
// into a real JavaScript value. For objects and arrays that made no difference,
// because `toJson` passes those straight through — which is why it stayed
// hidden while every JSON column in the schema held one.
//
// `settings.value` is the only column storing JSON SCALARS. Through pg they
// arrived as a number (24), a boolean (false) and an already-unwrapped string
// ("assisted"). `toJson` threw a TypeError on the first two and a SyntaxError
// on `JSON.parse('assisted')` for the third, so every caller of
// `settings.getAll()` failed on PostgreSQL and only on PostgreSQL: DECIDE, the
// executor's verification, and the revise engine.
//
// The fix registers pg type parsers that return the raw text, putting both
// drivers back on one contract. These tests pin that contract from the SQLite
// side, which is the only side this suite can run: `createTestDatabase()` is
// in-memory SQLite by construction. Proving it against a live PostgreSQL server
// is a targeted read-only check run by hand against the deployed database, and
// the result is recorded in the M7-F report rather than asserted here.

// ============================================== the contract toJson expects

test('toJson parses every JSON shape from stored text', () => {
  // What SQLite hands back, and — after the M7-F type parsers — what pg does too.
  assert.deepEqual(toJson(fromJson({ a: 1 }), null), { a: 1 });
  assert.deepEqual(toJson(fromJson([1, 2, 3]), null), [1, 2, 3]);
  assert.equal(toJson(fromJson(24), null), 24);
  assert.equal(toJson(fromJson(false), null), false);
  assert.equal(toJson(fromJson('assisted'), null), 'assisted');
  assert.equal(toJson(fromJson(0), null), 0);
  assert.equal(toJson(fromJson(''), null), '');
});

test('toJson round-trips every settings default', () => {
  // The values that actually broke. Each one goes out through `fromJson` and
  // comes back through `toJson`, which is exactly the path a settings row takes.
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const restored = toJson(fromJson(value), null);
    assert.deepEqual(restored, value, `${key} did not survive the round trip`);
  }

  // Named explicitly, because these three are the ones that failed in production.
  assert.equal(typeof toJson(fromJson(DEFAULT_SETTINGS.approval_sla_hours), null), 'number');
  assert.equal(typeof toJson(fromJson(DEFAULT_SETTINGS.outbound_send_enabled), null), 'boolean');
  assert.equal(typeof toJson(fromJson(DEFAULT_SETTINGS.autonomy_level), null), 'string');
});

test('toJson falls back rather than throwing on an absent value', () => {
  assert.deepEqual(toJson(null, { fallback: true }), { fallback: true });
  assert.deepEqual(toJson(undefined, { fallback: true }), { fallback: true });
  assert.deepEqual(toJson('', { fallback: true }), { fallback: true });
});

test('an already-parsed object is passed through untouched', () => {
  // pg behaved this way for objects before the fix and still may for any column
  // a future type parser does not cover, so the tolerance stays.
  const parsed = { already: 'parsed' };
  assert.equal(toJson(parsed, null), parsed);
});

test('NEGATIVE CONTROL — an already-parsed scalar is what used to break', () => {
  // This is the production failure, reproduced against the helper directly.
  // `toJson` still refuses a bare number, and that is correct: the contract is
  // that JSON columns arrive as text. The fix is that PostgreSQL now honours
  // that contract, not that this helper became permissive.
  assert.throws(() => toJson(24 as unknown, null), /Expected a JSON column value, received number/);
  assert.throws(() => toJson(false as unknown, null), /Expected a JSON column value, received boolean/);

  // And the string case, which is why loosening the helper would not have been
  // a fix: an unwrapped string is indistinguishable from stored JSON text.
  assert.throws(() => toJson('assisted', null), SyntaxError);
});

// ==================================== settings survive a real database round trip

test('settings round-trip through the database with a non-empty precondition', async () => {
  // The check my M7-C PostgreSQL verification got wrong: it called `getAll()`
  // against an EMPTY settings table, so the parsing loop never ran and the
  // failure could not surface. The precondition below is the whole point.
  const { repos, db, close } = await createTestContext();

  await repos.settings.seedDefaults();

  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM settings');
  assert.ok(
    Number(rows[0]?.n) >= 5,
    `PRECONDITION: settings must hold rows or this proves nothing (found ${rows[0]?.n})`,
  );

  const settings = await repos.settings.getAll();

  // The three shapes, by type, not merely by value.
  assert.equal(typeof settings.approval_sla_hours, 'number', 'a JSON number did not survive');
  assert.equal(typeof settings.outbound_send_enabled, 'boolean', 'a JSON boolean did not survive');
  assert.equal(typeof settings.autonomy_level, 'string', 'a JSON string did not survive');
  assert.equal(typeof settings.confidence_thresholds, 'object', 'a JSON object did not survive');
  assert.equal(typeof settings.business_profile, 'object', 'a JSON object did not survive');

  assert.equal(settings.approval_sla_hours, DEFAULT_SETTINGS.approval_sla_hours);
  assert.equal(settings.outbound_send_enabled, DEFAULT_SETTINGS.outbound_send_enabled);
  assert.equal(settings.autonomy_level, DEFAULT_SETTINGS.autonomy_level);

  await close();
});

test('a written setting reads back as the type it was written as', async () => {
  const { repos, close } = await createTestContext();
  await repos.settings.seedDefaults();

  await repos.settings.set('autonomy_level', 'assisted', 'test');
  await repos.settings.set('approval_sla_hours', 48, 'test');
  await repos.settings.set('outbound_send_enabled', true, 'test');

  const settings = await repos.settings.getAll();
  assert.equal(settings.autonomy_level, 'assisted');
  assert.equal(settings.approval_sla_hours, 48);
  assert.equal(settings.outbound_send_enabled, true);
  assert.equal(typeof settings.approval_sla_hours, 'number', 'a number came back as something else');
  assert.equal(typeof settings.outbound_send_enabled, 'boolean', 'a boolean came back as something else');

  await close();
});

// ====================================== the pg driver registers the parsers

test('the PostgreSQL driver asks pg for raw JSON text', () => {
  // Source-level, because the driver is only importable with `pg` present and
  // a connection string. What matters is that the registrations exist and cover
  // both JSON and JSONB — dropping either would resurrect the divergence.
  const source = fs.readFileSync(new URL('../src/db/postgres.ts', import.meta.url), 'utf8');

  assert.match(source, /setTypeParser\(\s*pg\.types\.builtins\.JSON\s*,/, 'the JSON type parser is not registered');
  assert.match(source, /setTypeParser\(\s*pg\.types\.builtins\.JSONB\s*,/, 'the JSONB type parser is not registered');
});
