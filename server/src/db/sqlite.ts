import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import type { Database, QueryResult, SqlParam } from './types.ts';

// SQLite driver, built on Node's own `node:sqlite`.
//
// Same reasoning Project 1 used for its conversation memory: `node:sqlite`
// ships with Node, needs no `npm install`, and has no native build step —
// which is why the whole M0 foundation can be migrated, seeded, and tested on
// a machine with no database server and no credentials.
//
// This is the local-development and test driver. Hosted deployments set
// DATABASE_URL and get the Postgres driver instead (D1); the repositories
// above this line cannot tell the difference.

type SqliteValue = string | number | bigint | null | Uint8Array;

function toSqliteParam(param: SqlParam): SqliteValue {
  // node:sqlite refuses booleans outright. Postgres accepts them natively, so
  // the conversion lives here rather than forcing every repository to write
  // 0/1 and lose the Postgres BOOLEAN type. Reading them back is handled by
  // `rows.ts`, which is where the other half of this asymmetry belongs.
  if (typeof param === 'boolean') return param ? 1 : 0;
  return param;
}

export function createSqliteDatabase(filePath: string): Database {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  // Off by default in SQLite, which would let the schema's REFERENCES clauses
  // silently do nothing — and the difference between the two drivers would
  // then only show up in production.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL keeps a reader from blocking the writer during a demo; harmless for
  // an in-memory database, which ignores it.
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  let savepointDepth = 0;
  let inTransaction = false;

  const wrap = (): Database => ({
    driver: 'sqlite',

    async query<Row = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
      const statement = db.prepare(sql);
      return statement.all(...params.map(toSqliteParam)) as Row[];
    },

    async execute(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult> {
      const statement = db.prepare(sql);
      const result = statement.run(...params.map(toSqliteParam));
      return { rowCount: Number(result.changes) };
    },

    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },

    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      const isNested = inTransaction;
      const name = `sp_${savepointDepth}`;

      if (isNested) {
        savepointDepth++;
        db.exec(`SAVEPOINT ${name}`);
      } else {
        inTransaction = true;
        db.exec('BEGIN');
      }

      try {
        const result = await fn(wrap());
        if (isNested) {
          db.exec(`RELEASE ${name}`);
          savepointDepth--;
        } else {
          db.exec('COMMIT');
          inTransaction = false;
        }
        return result;
      } catch (err) {
        if (isNested) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          savepointDepth--;
        } else {
          db.exec('ROLLBACK');
          inTransaction = false;
        }
        throw err;
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  });

  return wrap();
}
