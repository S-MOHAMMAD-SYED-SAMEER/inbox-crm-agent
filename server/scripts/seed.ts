import { config } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { appliedMigrations } from '../src/db/migrate.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';

// `npm run seed`
//
// Idempotent: run it as many times as you like. Records already present are
// skipped rather than duplicated (see db/seed.ts).

async function main(): Promise<void> {
  const db = await createDatabase(config);
  try {
    const migrations = await appliedMigrations(db);
    if (migrations.length === 0) {
      throw new Error('No migrations have been applied. Run `npm run migrate` first.');
    }

    const repos = createRepositories(db);
    const counts = await seedDemoData(repos, readSeedFile(config.demoDataDir));

    console.log('[seed] inserted:', {
      companies: counts.companies,
      contacts: counts.contacts,
      deals: counts.deals,
      tasks: counts.tasks,
      activities: counts.activities,
      notes: counts.notes,
    });
    if (counts.skipped > 0) console.log(`[seed] skipped ${counts.skipped} record(s) already present.`);

    console.log('[seed] CRM now holds:', {
      companies: await repos.companies.count(),
      contacts: await repos.contacts.count(),
      deals: await repos.deals.count(),
      tasks: await repos.tasks.count(),
      activities: await repos.activities.count(),
      notes: await repos.notes.count(),
    });
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
