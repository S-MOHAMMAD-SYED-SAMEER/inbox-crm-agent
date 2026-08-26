import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { clearAllData, readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { assessDemoReset, computeIdentity, verifyPristine, type ResetTargetKind } from '../src/demo/reset.ts';

// `npm run demo:reset`
//
// Returns a demo database to the state a demonstration starts from. All of the
// judgement lives in `src/demo/reset.ts`, which is tested; this file parses
// arguments, prints, and asks that module for permission.
//
//   npm run demo:reset -- --show-identity          what this connection is, safely
//   npm run demo:reset -- --local                  dry run against the local file
//   npm run demo:reset -- --local --confirm        do it
//   npm run demo:reset -- --production             dry run against the deployed demo
//   npm run demo:reset -- --production --confirm   do it
//
// A DRY RUN IS THE DEFAULT. Without `--confirm` this reads and reports and
// writes nothing, so the first thing anyone runs is always harmless.
//
// Pinning the deployed database, once:
//   npm run demo:reset -- --show-identity     then set DEMO_RESET_TARGET to the value.
// The fingerprint is a truncated one-way hash of host and database name, with
// credentials excluded, so it is safe to store and cannot be used to reach
// anything.

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);

const declaredKind: ResetTargetKind | null = has('--production')
  ? 'production'
  : has('--local')
    ? 'local'
    : null;
const confirmed = has('--confirm');

function line(): void {
  console.log('='.repeat(62));
}

async function main(): Promise<void> {
  const identity = config.databaseUrl ? computeIdentity(config.databaseUrl) : null;

  if (has('--show-identity')) {
    line();
    console.log(' CONNECTION IDENTITY');
    line();
    console.log(`  driver       : ${config.dbDriver}`);
    console.log(`  fingerprint  : ${identity ?? '(none — local file database)'}`);
    console.log('\n  This is a truncated one-way hash of the host and database name.');
    console.log('  Credentials are not part of it and cannot be recovered from it.');
    console.log('  Pin it by setting DEMO_RESET_TARGET to this value.');
    line();
    return;
  }

  const db = await createDatabase(config);
  try {
    // Read the fixture rather than hardcoding what "demo data" means, so the
    // allow-list cannot drift away from what the seed actually installs.
    const seedFile = readSeedFile(config.demoDataDir);
    const emailsPath = path.join(config.demoDataDir, 'emails.json');
    const demoMessageIds = (JSON.parse(fs.readFileSync(emailsPath, 'utf8')) as Array<{ providerMessageId: string }>)
      .map((email) => email.providerMessageId);

    const seedCounts: Record<string, number> = {
      companies: seedFile.companies.length,
      contacts: seedFile.contacts.length,
      deals: seedFile.deals.length,
      tasks: seedFile.tasks.length,
      activities: seedFile.activities.length,
      notes: seedFile.notes.length,
    };

    const assessment = await assessDemoReset(db, {
      driver: config.dbDriver,
      declaredKind,
      identity,
      expectedIdentity: process.env.DEMO_RESET_TARGET?.trim() || null,
      demoMessageIds,
      seedCounts,
    });

    if (!assessment.ok) {
      line();
      console.log(' REFUSED');
      line();
      console.log(`  reason : ${assessment.code}`);
      console.log(`  ${assessment.message}`);
      line();
      process.exitCode = 1;
      return;
    }

    // Always say what is about to happen, before anything happens.
    line();
    console.log(` DEMO RESET — ${confirmed ? 'CONFIRMED' : 'DRY RUN (nothing will be written)'}`);
    line();
    console.log(`  target   : ${assessment.kind} (${assessment.driver})`);
    if (identity) console.log(`  identity : ${identity}`);

    const totalDeleting = Object.values(assessment.willDelete).reduce((sum, n) => sum + n, 0);
    console.log(`\n  WILL DELETE (${totalDeleting} row(s)):`);
    for (const [table, count] of Object.entries(assessment.willDelete)) {
      if (count > 0) console.log(`    ${table.padEnd(20)} ${count}`);
    }
    if (totalDeleting === 0) console.log('    (nothing — the database is already empty)');

    console.log('\n  WILL RESTORE:');
    for (const [table, count] of Object.entries(assessment.willRestore)) {
      console.log(`    ${table.padEnd(20)} ${count}`);
    }
    console.log('    settings             5 defaults');
    console.log('    emails               0  <- deliberately empty, so the demo can ingest live');

    if (!confirmed) {
      line();
      console.log('  Dry run. Re-run with --confirm to perform it.');
      line();
      return;
    }

    const repos = createRepositories(db);
    await clearAllData(repos);
    const restored = await seedDemoData(repos, seedFile);

    console.log('\n  DONE:', JSON.stringify(restored));

    const check = await verifyPristine(db, seedCounts, 5);
    line();
    if (check.pristine) {
      console.log(' PRISTINE — ready for a demonstration');
      line();
      console.log('  The inbox is empty. The demo opens by ingesting.');
    } else {
      console.log(' NOT PRISTINE — review before demonstrating');
      line();
      for (const problem of check.problems) console.log(`  - ${problem}`);
      process.exitCode = 1;
    }
    line();
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[demo:reset] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
