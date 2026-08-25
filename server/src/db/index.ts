import { config, type AppConfig } from '../config/env.ts';
import { createSqliteDatabase } from './sqlite.ts';
import type { Database } from './types.ts';

export type { Database, SqlParam, QueryResult } from './types.ts';

/**
 * Builds the database for the current configuration.
 *
 * Driver selection is derived from DATABASE_URL rather than configured
 * separately (see config/env.ts): a postgres:// URL means Postgres, its
 * absence means the local SQLite file. A fresh clone therefore runs with no
 * database server, and deploying to Neon is one environment variable.
 *
 * `pg` is imported dynamically so a machine with no DATABASE_URL never loads
 * it — the SQLite path has no dependency on it at all.
 */
export async function createDatabase(cfg: AppConfig = config): Promise<Database> {
  if (cfg.dbDriver === 'postgres' && cfg.databaseUrl !== null) {
    const { createPostgresDatabase } = await import('./postgres.ts');
    return createPostgresDatabase(cfg.databaseUrl);
  }
  return createSqliteDatabase(cfg.sqlitePath);
}

/** An empty in-memory database — the starting point for every test. */
export function createTestDatabase(): Database {
  return createSqliteDatabase(':memory:');
}
