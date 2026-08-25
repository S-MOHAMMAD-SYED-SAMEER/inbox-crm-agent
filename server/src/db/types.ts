import type { DbDriverName } from '../config/env.ts';

// The single database interface every repository is written against.
//
// It is asynchronous even though the SQLite driver underneath is synchronous.
// That asymmetry is intentional: Postgres cannot be synchronous, and a
// repository that works against one driver but not the other would defeat the
// point of having an interface at all. The SQLite driver pays a trivial cost
// (already-resolved promises); the repositories stay driver-agnostic.

export type SqlParam = string | number | boolean | null;

export type QueryResult = { rowCount: number };

export type Database = {
  readonly driver: DbDriverName;

  /** Runs a SELECT and returns rows as plain objects. */
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<Row[]>;

  /** Runs a single INSERT/UPDATE/DELETE and reports how many rows it touched. */
  execute(sql: string, params?: readonly SqlParam[]): Promise<QueryResult>;

  /** Runs DDL or other statements that take no parameters. */
  exec(sql: string): Promise<void>;

  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nesting is supported through savepoints, so a repository method
   * that opens a transaction stays correct when a caller has already opened
   * one — the case that makes "atomic plan application" (§15) composable.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;

  close(): Promise<void>;
};
