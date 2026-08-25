import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { splitStatements, translateDdl } from './dialect.ts';
import type { Database } from './types.ts';

// Migration runner — about eighty lines, no framework (NFR-9).
//
// What a migration framework would add over this: generators, rollbacks, and a
// DSL. Rollbacks are the only one worth wanting, and a rollback of a schema
// change in a system with real data is a decision, not a command — the honest
// version is a new forward migration. So the whole apparatus reduces to:
// "apply the files that have not been applied, in order, once each."
//
// The checksum is the part that earns its place. Editing a migration that has
// already run is one of the few genuinely dangerous things a person can do to
// a database — the schema and the file silently disagree from then on. Storing
// a hash turns that into a loud error on the next run.

export type MigrationFile = { version: string; name: string; sql: string };
export type AppliedMigration = { version: string; name: string; checksum: string; appliedAt: string };

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
)`;

export function readMigrations(directory: string): MigrationFile[] {
  if (!fs.existsSync(directory)) {
    throw new Error(`Migrations directory not found: ${directory}`);
  }

  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort() // zero-padded numeric prefixes make lexical order the intended order
    .map((file) => {
      const version = file.split('_')[0] ?? file;
      return {
        version,
        name: file,
        sql: fs.readFileSync(path.join(directory, file), 'utf8'),
      };
    });
}

export function checksumOf(sql: string): string {
  // Line endings are normalised first so that a file checked out on Windows
  // does not appear "modified" against one applied on Linux.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export type MigrationReport = {
  applied: string[];
  skipped: string[];
  driver: string;
};

export async function runMigrations(
  db: Database,
  directory: string,
  options: { now?: () => string } = {},
): Promise<MigrationReport> {
  const now = options.now ?? (() => new Date().toISOString());
  await db.exec(MIGRATIONS_TABLE);

  const alreadyApplied = await db.query<{ version: string; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM schema_migrations',
  );
  const appliedByVersion = new Map(alreadyApplied.map((row) => [row.version, row]));

  const report: MigrationReport = { applied: [], skipped: [], driver: db.driver };

  for (const migration of readMigrations(directory)) {
    const checksum = checksumOf(migration.sql);
    const previous = appliedByVersion.get(migration.version);

    if (previous) {
      if (previous.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied. ` +
            'Applied migrations are immutable — add a new migration instead of editing this one.',
        );
      }
      report.skipped.push(migration.name);
      continue;
    }

    const statements = splitStatements(translateDdl(migration.sql, db.driver as 'sqlite' | 'postgres'));

    // One transaction per migration file: a half-applied schema is far worse
    // than an unapplied one. (Postgres is fully transactional for DDL; SQLite
    // is too. This is one of the few places where both engines behave the same
    // and it happens to be the place where it matters most.)
    await db.transaction(async (tx) => {
      for (const statement of statements) {
        try {
          await tx.exec(statement);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`Migration ${migration.name} failed on statement:\n${statement}\n\n${detail}`);
        }
      }
      await tx.execute(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, checksum, now()],
      );
    });

    report.applied.push(migration.name);
  }

  return report;
}

export async function appliedMigrations(db: Database): Promise<AppliedMigration[]> {
  await db.exec(MIGRATIONS_TABLE);
  const rows = await db.query<{ version: string; name: string; checksum: string; applied_at: string }>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}
