import { createHash } from 'node:crypto';
import type { Database } from '../db/types.ts';

// Returning the deployed demo to its pristine state (M7-F).
//
// WHY THIS IS NOT `scripts/reset.ts`
//
// That script refuses any non-SQLite database on purpose — it is the guard that
// stops a stray `npm run reset` destroying a hosted database, and it stays
// exactly as it is. But it leaves the deployed demo single-use: once a
// demonstration has run, emails reach terminal states, approvals settle, and
// agent-created CRM rows accumulate. The next client sees a used system, and
// the strongest moment — watching the assistant read the inbox live — is gone.
// Terminal states cannot re-enter the pipeline, so re-running is not an option
// either.
//
// So this is a second, narrower mechanism: it may touch a hosted database, and
// it earns that by refusing far more than the generic one does.
//
// THE SAFETY MODEL, IN THE ORDER IT IS APPLIED
//
//   1. Dry run by default. Nothing is written without an explicit confirmation.
//   2. The caller must name the kind of database it believes it is talking to.
//      Asking for `production` while connected to SQLite is a refusal, not a
//      convenience — a mismatch means someone's assumption is already wrong.
//   3. A hosted database must match a pinned identity fingerprint. The
//      fingerprint is a one-way hash of the connection target, so it is safe to
//      store in an environment variable and reveals nothing about the
//      connection string. If DATABASE_URL is ever repointed — at the M5-E
//      verification branch, say — the fingerprint stops matching and the reset
//      refuses rather than following it.
//   4. Every row present must be recognisable demo data: emails from the demo
//      provider carrying known fixture ids, and CRM records that were either
//      seeded or written by the agent. Anything else and it aborts without
//      touching a row, because "I do not recognise this" is the one situation
//      where guessing is unforgivable.
//
// Any uncertainty is a refusal. There is no path through this file that writes
// while a precondition is unresolved.

/** What the caller asserts it is connected to. Nothing is inferred. */
export type ResetTargetKind = 'local' | 'production';

export const REFUSAL_CODES = [
  'no_target_declared',
  'driver_mismatch',
  'identity_not_pinned',
  'identity_mismatch',
  'unrecognised_email',
  'unrecognised_crm_source',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type ResetRefusal = { ok: false; code: RefusalCode; message: string };

export type ResetPlan = {
  ok: true;
  kind: ResetTargetKind;
  driver: string;
  /** Rows that will be removed, by table. */
  willDelete: Record<string, number>;
  /** What the seed will put back. */
  willRestore: Record<string, number>;
};

export type ResetAssessment = ResetPlan | ResetRefusal;

/**
 * A stable, non-reversible fingerprint of a connection target.
 *
 * Only the database name and host are hashed — never the credentials — and the
 * result is truncated, so it identifies a target without being usable to reach
 * one. This is what makes it safe to paste into an environment variable.
 */
export function computeIdentity(databaseUrl: string): string {
  let target = databaseUrl.trim();
  try {
    const parsed = new URL(databaseUrl);
    // host + path only. Username and password are deliberately excluded.
    target = `${parsed.host}${parsed.pathname}`;
  } catch {
    // Not a URL. Hash whatever was given rather than throwing: a malformed
    // value must fail the comparison, not crash before reaching it.
  }
  return createHash('sha256').update(target).digest('hex').slice(0, 16);
}

/** The tables the demo occupies, in dependency order. */
const WORKFLOW_TABLES = [
  'audit_events',
  'outbox_messages',
  'action_executions',
  'approvals',
  'decisions',
  'entity_matches',
  'email_analyses',
  'sessions',
  'emails',
] as const;

const CRM_TABLES = ['notes', 'activities', 'tasks', 'deals', 'contacts', 'companies'] as const;

/** Sources a CRM row may legitimately carry in a demo database. */
const KNOWN_SOURCES = new Set(['seed', 'agent']);

async function countOf(db: Database, table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

export type AssessOptions = {
  driver: string;
  /** What the caller declared. `null` means it declared nothing. */
  declaredKind: ResetTargetKind | null;
  /** The live connection's fingerprint, or null for a local file database. */
  identity: string | null;
  /** The pinned value the operator configured, if any. */
  expectedIdentity: string | null;
  /** Provider message ids the demo fixture defines. Never invented here. */
  demoMessageIds: readonly string[];
  /** Row counts the seed is expected to restore. */
  seedCounts: Record<string, number>;
};

/**
 * Decides whether a reset may proceed, and what it would do.
 *
 * Reads only. Nothing here writes, so an assessment is always safe to run and
 * is what the dry run reports.
 */
export async function assessDemoReset(db: Database, options: AssessOptions): Promise<ResetAssessment> {
  const { driver, declaredKind, identity, expectedIdentity, demoMessageIds, seedCounts } = options;

  // 1. The caller must say what it thinks it is talking to.
  if (declaredKind === null) {
    return {
      ok: false,
      code: 'no_target_declared',
      message: 'No target was declared. Pass --local or --production to say which database you mean.',
    };
  }

  // 2. And be right about it. A mismatch means an assumption is already wrong,
  //    which is the worst moment to start deleting rows.
  const isHosted = driver !== 'sqlite';
  if (declaredKind === 'production' && !isHosted) {
    return {
      ok: false,
      code: 'driver_mismatch',
      message: `--production was requested but the connection is "${driver}". Refusing: nothing will silently fall back to a local database.`,
    };
  }
  if (declaredKind === 'local' && isHosted) {
    return {
      ok: false,
      code: 'driver_mismatch',
      message: `--local was requested but the connection is "${driver}", which is not a local database. Refusing.`,
    };
  }

  // 3. A hosted database must be the one that was pinned.
  if (declaredKind === 'production') {
    if (!expectedIdentity) {
      return {
        ok: false,
        code: 'identity_not_pinned',
        message:
          'DEMO_RESET_TARGET is not set, so there is nothing to check this connection against. ' +
          'Run with --show-identity and pin the value first.',
      };
    }
    if (identity !== expectedIdentity) {
      return {
        ok: false,
        code: 'identity_mismatch',
        message:
          'This connection is not the pinned demo database. Refusing. ' +
          'DATABASE_URL may be pointing somewhere else — the M5-E verification branch, for instance.',
      };
    }
  }

  // 4. Everything present must be recognisable demo data.
  const known = new Set(demoMessageIds);
  const emails = await db.query<{ provider: string; provider_message_id: string }>(
    'SELECT provider, provider_message_id FROM emails',
  );
  for (const email of emails) {
    const provider = String(email.provider);
    const messageId = String(email.provider_message_id);
    if (provider !== 'demo' || !known.has(messageId)) {
      return {
        ok: false,
        code: 'unrecognised_email',
        message:
          `Found an email this reset does not recognise (provider "${provider}"). ` +
          'It is not part of the demo fixture, so this database is not a pure demo database. Aborting without deleting anything.',
      };
    }
  }

  for (const table of CRM_TABLES) {
    const rows = await db.query<{ source: string }>(`SELECT DISTINCT source FROM ${table}`);
    for (const row of rows) {
      const source = String(row.source);
      if (!KNOWN_SOURCES.has(source)) {
        return {
          ok: false,
          code: 'unrecognised_crm_source',
          message:
            `Table "${table}" holds a record with source "${source}", which is neither seeded nor agent-created. ` +
            'Something put real data here. Aborting without deleting anything.',
        };
      }
    }
  }

  // Everything checks out. Report exactly what would go.
  const willDelete: Record<string, number> = {};
  for (const table of [...WORKFLOW_TABLES, ...CRM_TABLES]) {
    willDelete[table] = await countOf(db, table);
  }

  return { ok: true, kind: declaredKind, driver, willDelete, willRestore: { ...seedCounts } };
}

export type PristineCheck = { pristine: boolean; problems: string[]; counts: Record<string, number> };

/**
 * Confirms the database is in the state a demonstration starts from.
 *
 * The inbox must be EMPTY. That is deliberate and is the whole point: the demo
 * opens by ingesting, and an inbox that already holds messages has skipped the
 * first thing a client is shown.
 */
export async function verifyPristine(
  db: Database,
  seedCounts: Record<string, number>,
  expectedSettings: number,
): Promise<PristineCheck> {
  const problems: string[] = [];
  const counts: Record<string, number> = {};

  for (const table of WORKFLOW_TABLES) {
    counts[table] = await countOf(db, table);
    if (counts[table] !== 0) problems.push(`${table} holds ${counts[table]} row(s); a pristine demo has none`);
  }

  for (const [table, expected] of Object.entries(seedCounts)) {
    counts[table] = await countOf(db, table);
    if (counts[table] !== expected) {
      problems.push(`${table} holds ${counts[table]} row(s); the seed defines ${expected}`);
    }
  }

  counts.settings = await countOf(db, 'settings');
  if (counts.settings !== expectedSettings) {
    problems.push(`settings holds ${counts.settings} row(s); ${expectedSettings} defaults are expected`);
  }

  return { pristine: problems.length === 0, problems, counts };
}
