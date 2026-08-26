import pg from 'pg';
import { convertPlaceholders } from './dialect.ts';
import type { Database, QueryResult, SqlParam } from './types.ts';

// PostgreSQL driver (D1) — the hosted path, Neon or otherwise.
//
// STATUS: verified against a live PostgreSQL 18.6 server (M5-E, M7-C) and
// running in production since M7-D. The note that used to sit here said the
// driver was unverified and that the first job of whichever milestone
// provisioned a database was to run the suites against it. That happened, and
// it was not enough: the suites are driver-agnostic in their SQL but they all
// run on SQLite, so a divergence in how a driver *returns* a value passed every
// one of them. See the JSON note below for the one that reached production.
//
// This module is loaded lazily by `db/index.ts` so that a machine without a
// database URL never imports `pg` at all.

const { Pool } = pg;

// --- JSON columns must look the same from both drivers (M7-F) ---------------
//
// `node:sqlite` returns a JSON column as the text it stored. `pg` parses JSONB
// and hands back a real JavaScript value. For an object or an array that made
// no difference — `toJson` passes those through untouched — so this divergence
// stayed invisible for as long as every JSON column held one.
//
// `settings.value` is the exception, and the only column in the schema storing
// JSON *scalars*: 24, false, "assisted". Through pg those arrive as a number, a
// boolean and an already-unwrapped string, and `toJson` threw on the first two
// and tried to `JSON.parse('assisted')` on the third. Every caller of
// `settings.getAll()` therefore failed on PostgreSQL and only on PostgreSQL —
// DECIDE, the executor's verification, and the revise engine among them — while
// every test and the whole walkthrough passed on SQLite.
//
// Asking pg for the raw text puts both drivers back on the same contract, so
// `toJson` parses exactly once no matter where the row came from. Fixing it
// here rather than in `toJson` is deliberate: teaching `toJson` to accept a
// number and a boolean would still leave the string case wrong, because a JSON
// string that happens to contain valid JSON (`"123"`) would be parsed twice.
//
// Safe because every JSONB read in the codebase goes through `toJson`; the one
// direct access, in `approvals.ts`, is a null comparison rather than a parse.
pg.types.setTypeParser(pg.types.builtins.JSON, (value) => value);
pg.types.setTypeParser(pg.types.builtins.JSONB, (value) => value);

function toPgParams(params: readonly SqlParam[]): unknown[] {
  return [...params];
}

export function createPostgresDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    // Neon and most hosted Postgres providers terminate plaintext connections.
    // Local development against a plain server keeps working because the flag
    // is only set when the URL does not already say otherwise.
    ...(/\bsslmode=/.test(connectionString) ? {} : { ssl: { rejectUnauthorized: true } }),
    max: 5,
  });

  const wrapClient = (client: pg.PoolClient | pg.Pool, depth: number): Database => ({
    driver: 'postgres',

    async query<Row = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
      const result = await client.query(convertPlaceholders(sql), toPgParams(params));
      return result.rows as Row[];
    },

    async execute(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult> {
      const result = await client.query(convertPlaceholders(sql), toPgParams(params));
      return { rowCount: result.rowCount ?? 0 };
    },

    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },

    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      // A nested call must run on the *same* client as its parent, or it would
      // be a separate connection outside the parent's transaction — which
      // would quietly break atomicity rather than fail loudly.
      if (depth > 0) {
        const name = `sp_${depth}`;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn(wrapClient(client, depth + 1));
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await client.query(`RELEASE SAVEPOINT ${name}`);
          throw err;
        }
      }

      const dedicated = await pool.connect();
      try {
        await dedicated.query('BEGIN');
        const result = await fn(wrapClient(dedicated, 1));
        await dedicated.query('COMMIT');
        return result;
      } catch (err) {
        await dedicated.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        dedicated.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  });

  return wrapClient(pool, 0);
}
