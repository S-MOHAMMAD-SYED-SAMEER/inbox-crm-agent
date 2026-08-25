import { randomUUID, createHash } from 'node:crypto';

// Identity generation (spec §9 portability rules).
//
// IDs are generated in application code, never by the database. Two
// consequences, both load-bearing:
//
//   1. No `gen_random_uuid()`, so no pgcrypto extension, so the same DDL runs
//      on Postgres and SQLite unchanged.
//   2. An id exists *before* the row does. That is what lets EXECUTE (M4) build
//      a multi-action plan in memory — where action 3 references the company
//      action 1 will create — and then write the whole thing in one
//      transaction. If ids came back from INSERTs, the plan would have to be
//      applied step-by-step and atomicity would be gone.

export type IdGenerator = () => string;

export const newId: IdGenerator = () => randomUUID();

/**
 * A deterministic id generator for tests and evaluations.
 *
 * Same prefix and same call order produce the same ids, every run — which is
 * what makes a failing test reproducible and an evaluation comparable between
 * runs.
 *
 * IT MUST PRODUCE VALID UUIDs, AND THAT WAS LEARNED THE HARD WAY (M5-E).
 *
 * It used to return `prefix-1`, `prefix-2`, on the reasoning that a readable id
 * makes a failure easier to read. That worked only because SQLite maps the
 * schema's `UUID` columns to `TEXT` and accepts any string. PostgreSQL enforces
 * the type, so the first insert against a real server failed with
 * `invalid input syntax for type uuid` — and every test and all six evaluations
 * were therefore incapable of running against the database this project is
 * actually designed to deploy on.
 *
 * Deriving from `deterministicId` keeps the determinism, keeps the prefix
 * meaningful (a given prefix always yields the same sequence), and produces ids
 * both drivers accept. The readability that was lost was worth less than the
 * ability to test against Postgres at all.
 */
export function createSequentialIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return () => deterministicId(`${prefix}-${++n}`);
}

/**
 * A stable UUID derived from a name — same name in, same id out, forever.
 *
 * The seed data uses this so that the demo can be reset to *exactly* the same
 * state, ids included (NFR-1), while the seed file itself stays readable: it
 * references `company:harborview-digital` rather than a hex string nobody can
 * check. Deriving the id also means the fixture file cannot contain a typo'd
 * UUID that points at nothing.
 *
 * Shaped as a v5-style UUID (version nibble 5, RFC-4122 variant) because it is
 * exactly that: a name-based, deterministic id — as opposed to `newId()`, which
 * is random and used for everything the system creates at runtime.
 */
export function deterministicId(name: string): string {
  const hex = createHash('sha256').update(`inbox-crm-agent:${name}`).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Stable SHA-256 over a JSON-serialisable value, with object keys sorted so
 * that `{a,b}` and `{b,a}` hash identically.
 *
 * Used for two things that both depend on "same input ⇒ same output":
 *   - `idempotency_key` on an execution (FR-29), so a retry cannot double-write.
 *   - `inputDigest` in an audit payload (§17), which records *that* an input was
 *     the same without copying personal data into a second, never-deleted table.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}
