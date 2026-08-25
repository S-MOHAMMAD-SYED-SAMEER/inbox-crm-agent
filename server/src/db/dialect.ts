// SQL dialect handling — the mechanism that makes spec §9's portability rules
// real rather than aspirational.
//
// WHY THIS EXISTS
//
// D1 selected PostgreSQL, and the migrations in `migrations/` are written as
// PostgreSQL DDL exactly as specified. But a foundation whose schema and
// repositories can only be *run* against a hosted database is a foundation
// nobody can test: there is no Postgres server, no Docker, and no Neon account
// on this machine, and M0's own definition of done is that `npm run migrate &&
// npm run seed` works and the repository tests pass with zero credentials.
//
// So there are two drivers behind one `Database` interface: Node's built-in
// `node:sqlite` (zero dependencies — the same choice Project 1 made for its
// conversation memory) for local development and tests, and `pg` for a hosted
// Postgres. The spec's portability rules were written to permit exactly this,
// and honouring them is what keeps D1 reversible.
//
// WHAT THIS FILE IS NOT
//
// It is not a general SQL translator, and it must never become one. It handles
// a closed list of *declared type tokens* and one default expression, all of
// which appear only in DDL that lives in this repository. It does not parse,
// rewrite, or reorder statements. If a migration ever needs something outside
// this list, the right move is to widen the list deliberately — with a test —
// rather than to make the translation cleverer.

import type { DbDriverName } from '../config/env.ts';

/**
 * Type tokens are matched case-sensitively in UPPER CASE, which is safe
 * because every type in our DDL is uppercase and every identifier is
 * lowercase snake_case. `expected_close_date DATE` translates its type and
 * leaves the column name alone precisely because of that convention.
 */
const SQLITE_TYPE_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bUUID\b/g, 'TEXT'],
  [/\bTIMESTAMPTZ\b/g, 'TEXT'],
  [/\bJSONB\b/g, 'TEXT'],
  [/\bDATE\b/g, 'TEXT'],
  [/\bNUMERIC\s*\(\s*\d+\s*,\s*\d+\s*\)/g, 'REAL'],
  [/\bBOOLEAN\b/g, 'INTEGER'],
  [/\bSMALLINT\b/g, 'INTEGER'],
  [/\bBIGINT\b/g, 'INTEGER'],
];

// Postgres `now()` is a timestamptz; SQLite's nearest equivalent produces
// 'YYYY-MM-DD HH:MM:SS', which is *not* the ISO-8601 UTC format this system
// uses everywhere else. strftime with %fZ produces the matching format, so a
// column default can never introduce a second timestamp format through the
// back door. (In practice these defaults are rarely exercised: every
// repository supplies timestamps from the injectable clock — see lib/clock.ts.)
const SQLITE_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export function translateDdl(ddl: string, driver: DbDriverName): string {
  if (driver === 'postgres') return ddl;

  let out = ddl;
  // Cast suffixes first: `'{}'::jsonb` must lose the cast before JSONB→TEXT
  // runs, or the leftover `::TEXT` would be a syntax error in SQLite.
  out = out.replace(/::\s*jsonb\b/gi, '');
  out = out.replace(/\bDEFAULT\s+now\(\)/gi, `DEFAULT ${SQLITE_NOW}`);
  for (const [pattern, replacement] of SQLITE_TYPE_MAP) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Converts `?` placeholders to Postgres `$1, $2, ...`.
 *
 * Every query in this codebase is written with `?` — the more portable of the
 * two spellings — and converted here for Postgres. The conversion is a
 * character scan rather than a regex because a `?` inside a string literal or
 * a quoted identifier is data, not a placeholder, and replacing it would
 * silently corrupt a query. That case does not occur in the current codebase;
 * handling it anyway costs fifteen lines and removes a trap that would be very
 * unpleasant to debug later.
 */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i] as string;

    if (inSingle) {
      out += char;
      if (char === "'") {
        if (sql[i + 1] === "'") {
          // An escaped quote ('') inside a literal — consume both and stay in.
          out += sql[i + 1] as string;
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      out += char;
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      out += char;
      continue;
    }
    if (char === '?') {
      out += `$${++index}`;
      continue;
    }
    out += char;
  }

  return out;
}

/**
 * Splits a migration file into individual statements.
 *
 * `node:sqlite`'s `exec()` runs multiple statements, but `pg` does not accept
 * them in one parameterised call and, more importantly, per-statement
 * execution means a failure names the statement that failed rather than the
 * whole file.
 *
 * One scanner does comment stripping and splitting together, because both
 * depend on the same question — "am I inside a string right now?" — and
 * answering it twice, in two passes, is how a `;` inside a literal ends up
 * cutting a statement in half.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i] as string;
    const next = sql[i + 1];

    // -- line comment, outside any quotes
    if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      current += '\n';
      continue;
    }

    // /* block comment */
    if (char === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }

    // '...' string literal, with '' as an escaped quote
    if (char === "'") {
      current += char;
      i++;
      while (i < sql.length) {
        const inner = sql[i] as string;
        current += inner;
        if (inner === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1] as string;
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }

    // "..." quoted identifier
    if (char === '"') {
      current += char;
      i++;
      while (i < sql.length) {
        const inner = sql[i] as string;
        current += inner;
        if (inner === '"') break;
        i++;
      }
      continue;
    }

    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);

  return statements;
}
