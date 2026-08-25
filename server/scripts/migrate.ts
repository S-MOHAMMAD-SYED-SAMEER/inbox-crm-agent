import { config, configProblems } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { runMigrations, appliedMigrations } from '../src/db/migrate.ts';

// `npm run migrate`
//
// Runs against whatever DATABASE_URL points at — or, with none set, the local
// SQLite file. Both paths use the identical migration files; only the type
// tokens differ, and that translation is in one tested module (db/dialect.ts).

async function main(): Promise<void> {
  for (const problem of configProblems) console.warn(`[config] ${problem}`);

  const db = await createDatabase(config);
  try {
    const report = await runMigrations(db, config.migrationsDir);

    console.log(`[migrate] driver: ${report.driver}`);
    if (report.applied.length === 0) {
      console.log('[migrate] Already up to date.');
    } else {
      for (const name of report.applied) console.log(`[migrate] applied ${name}`);
    }
    if (report.skipped.length > 0) {
      console.log(`[migrate] ${report.skipped.length} migration(s) already applied.`);
    }

    const all = await appliedMigrations(db);
    console.log(`[migrate] schema is at ${all.length} migration(s).`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
