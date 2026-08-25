import { config } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { clearAllData, readSeedFile, seedDemoData } from '../src/db/seed.ts';

// `npm run reset` — restore the demo to its exact starting state.
//
// This DELETES EVERY ROW and re-seeds. That is destructive by definition, so
// it refuses to run against a hosted database: a `postgres://` URL points at
// something shared, and "I reset the demo" must never be able to mean "I
// cleared the client's data". Local SQLite only, no flag to override.
//
// Project 1 learned the value of a one-command restore the hard way — its
// knowledge base needed a self-restoring mechanism after a demo-time risk was
// found. This is the same lesson, applied before rather than after.

async function main(): Promise<void> {
  if (config.dbDriver !== 'sqlite') {
    throw new Error(
      'Refusing to reset a non-local database. This command deletes every row and is intended ' +
        'only for the local SQLite demo database. Unset DATABASE_URL to use it.',
    );
  }

  const db = await createDatabase(config);
  try {
    await runMigrations(db, config.migrationsDir);

    const repos = createRepositories(db);
    await clearAllData(repos);
    console.log('[reset] cleared all data.');

    const counts = await seedDemoData(repos, readSeedFile(config.demoDataDir));
    console.log('[reset] reseeded:', {
      companies: counts.companies,
      contacts: counts.contacts,
      deals: counts.deals,
      tasks: counts.tasks,
      activities: counts.activities,
      notes: counts.notes,
    });
    console.log('[reset] demo is back to its starting state.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[reset] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
