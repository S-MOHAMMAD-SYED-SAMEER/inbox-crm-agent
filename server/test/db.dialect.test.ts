import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateDdl, convertPlaceholders, splitStatements } from '../src/db/dialect.ts';

// The dialect layer is the riskiest code in the foundation: it rewrites SQL,
// and a rewrite that is subtly wrong produces a schema that looks fine and
// behaves differently. So it is tested harder than its size suggests,
// especially on the cases where it must NOT act.

test('postgres DDL passes through untouched', () => {
  const ddl = 'CREATE TABLE t (id UUID PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), doc JSONB)';
  assert.equal(translateDdl(ddl, 'postgres'), ddl);
});

test('sqlite translation maps every declared type token', () => {
  const ddl = `CREATE TABLE t (
    id UUID PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    doc JSONB NOT NULL,
    due DATE,
    score NUMERIC(4,3),
    flag BOOLEAN NOT NULL,
    seq SMALLINT,
    amount BIGINT
  )`;
  const out = translateDdl(ddl, 'sqlite');

  assert.doesNotMatch(out, /\bUUID\b/);
  assert.doesNotMatch(out, /\bTIMESTAMPTZ\b/);
  assert.doesNotMatch(out, /\bJSONB\b/);
  assert.doesNotMatch(out, /\bNUMERIC\s*\(/);
  assert.doesNotMatch(out, /\bBOOLEAN\b/);
  assert.match(out, /score REAL/);
  assert.match(out, /seq INTEGER/);
  assert.match(out, /amount INTEGER/);
});

test('sqlite translation replaces now() with an ISO-8601 UTC expression', () => {
  const out = translateDdl("created_at TIMESTAMPTZ NOT NULL DEFAULT now()", 'sqlite');
  assert.match(out, /strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/);
  // The whole point: the default must produce the same format the application
  // writes, not SQLite's space-separated one.
  assert.doesNotMatch(out, /DEFAULT now\(\)/);
});

test('sqlite translation strips ::jsonb casts before mapping the type', () => {
  const out = translateDdl("headers JSONB NOT NULL DEFAULT '{}'::jsonb", 'sqlite');
  assert.match(out, /DEFAULT '\{\}'/);
  assert.doesNotMatch(out, /::/);
});

test('translation does not touch lowercase identifiers that look like types', () => {
  // `expected_close_date DATE` must translate the type and leave the column
  // name alone — this is the case that would silently corrupt a schema.
  const out = translateDdl('expected_close_date DATE, update_date DATE', 'sqlite');
  assert.match(out, /expected_close_date TEXT/);
  assert.match(out, /update_date TEXT/);
  assert.doesNotMatch(out, /expected_close_TEXT/);
});

test('placeholders convert to numbered postgres parameters in order', () => {
  assert.equal(
    convertPlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)'),
    'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)',
  );
  assert.equal(convertPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
});

test('a question mark inside a string literal is data, not a placeholder', () => {
  assert.equal(
    convertPlaceholders("SELECT * FROM t WHERE label = 'why?' AND id = ?"),
    "SELECT * FROM t WHERE label = 'why?' AND id = $1",
  );
});

test('an escaped quote inside a literal does not end the literal', () => {
  assert.equal(
    convertPlaceholders("SELECT * FROM t WHERE s = 'it''s ? here' AND id = ?"),
    "SELECT * FROM t WHERE s = 'it''s ? here' AND id = $1",
  );
});

test('a question mark inside a quoted identifier is left alone', () => {
  assert.equal(convertPlaceholders('SELECT "od?d" FROM t WHERE id = ?'), 'SELECT "od?d" FROM t WHERE id = $1');
});

test('statement splitting drops line comments and empty statements', () => {
  const statements = splitStatements(`
    -- a leading comment
    CREATE TABLE a (id TEXT);  -- trailing comment
    ;
    CREATE TABLE b (id TEXT);
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0] as string, /CREATE TABLE a/);
  assert.match(statements[1] as string, /CREATE TABLE b/);
  assert.doesNotMatch(statements.join(' '), /comment/);
});

test('a semicolon inside a string literal does not split a statement', () => {
  const statements = splitStatements("INSERT INTO t (s) VALUES ('a; b')");
  assert.equal(statements.length, 1);
});
