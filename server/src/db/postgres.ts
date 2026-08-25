import pg from 'pg';
import { convertPlaceholders } from './dialect.ts';
import type { Database, QueryResult, SqlParam } from './types.ts';

// PostgreSQL driver (D1) — the hosted path, Neon or otherwise.
//
// STATUS, STATED HONESTLY: this driver is implemented and typechecked, but it
// has not been run against a live PostgreSQL server, because this machine has
// no Postgres, no Docker, and (by instruction) no Neon account. Its behaviour
// is therefore *unverified* in a way the SQLite driver's is not. The first task
// of whichever milestone provisions a database is to run the existing
// repository and migration suites against it — they are driver-agnostic by
// construction, so that is a configuration change, not new tests.
//
// This module is loaded lazily by `db/index.ts` so that a machine without a
// database URL never imports `pg` at all.

const { Pool } = pg;

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
