import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResolveEvaluation, resolveThresholdFailures } from '../src/eval/resolve/runner.ts';

// `npm run eval:resolve`
//
// Deterministic, offline, no API key and no spend — resolution makes no model
// call at all. Exits non-zero when a threshold is missed, so it gates the
// milestone rather than merely reporting on it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runResolveEvaluation({
    datasetPath: path.join(SERVER_ROOT, 'eval', 'resolve.dataset.json'),
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  console.log(`\nENTITY RESOLUTION evaluation — dataset ${report.version} (deterministic, no model call)\n`);

  for (const result of report.results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id.padEnd(5)} ${result.description}`);
    for (const failed of result.checks.filter((c) => !c.passed)) {
      console.log(`          ${failed.name}: ${failed.detail}`);
    }
  }

  const { metrics } = report;
  console.log(`\n  Cases: ${metrics.passed}/${metrics.cases} passed\n`);
  console.log('  Metrics');
  console.log(`    verdictAccuracy        ${metrics.verdictAccuracy}       (min 1)`);
  console.log(`    conflictsDetected      ${metrics.conflictsDetected}       (min 1 — E-04)`);
  console.log(`    conflictsLinked        ${metrics.conflictsLinked}       (max 0)`);
  console.log(`    crmWrites              ${metrics.crmWrites}       (max 0 — resolution is read-only)`);

  const failures = resolveThresholdFailures(metrics);
  if (failures.length > 0) {
    console.error('\n  THRESHOLDS NOT MET:');
    for (const failure of failures) console.error(`    - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n  All thresholds met.\n');
}

main().catch((err: unknown) => {
  console.error('[eval] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
