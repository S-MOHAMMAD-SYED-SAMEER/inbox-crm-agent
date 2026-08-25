import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../src/eval/understand/runner.ts';
import { THRESHOLDS, MAXIMUM_METRICS, thresholdFailures } from '../src/eval/understand/metrics.ts';

// `npm run eval:understand`
//
// Mock mode only, no API key, no spend, deterministic. Exits non-zero when a
// threshold is missed, so it can gate a milestone rather than just inform.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runEvaluation({
    datasetPath: path.join(SERVER_ROOT, 'eval', 'understand.dataset.json'),
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  console.log(`\nUNDERSTAND evaluation — dataset ${report.version} (mock provider, no API calls)\n`);

  for (const result of report.results) {
    const failed = result.checks.filter((check) => !check.passed);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id.padEnd(5)} ${result.description}`);
    for (const check of failed) {
      console.log(`          ${check.name}: ${check.detail}`);
    }
  }

  console.log(`\n  Cases: ${report.metrics.passed}/${report.metrics.cases} passed\n`);
  console.log('  Metrics');
  for (const [name, value] of Object.entries(report.metrics)) {
    if (name === 'cases' || name === 'passed') continue;
    const threshold = THRESHOLDS[name];
    const suffix =
      threshold === undefined
        ? ''
        : MAXIMUM_METRICS.has(name)
          ? `  (max ${threshold})`
          : `  (min ${threshold})`;
    console.log(`    ${name.padEnd(24)} ${String(value).padEnd(8)}${suffix}`);
  }

  const failures = thresholdFailures(report.metrics);
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
