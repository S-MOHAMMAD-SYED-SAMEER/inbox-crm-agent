import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDecideEvaluation, decideThresholdFailures } from '../src/eval/decide/runner.ts';

// `npm run eval:decide`
//
// Deterministic and offline. The only model call is drafting, and it replays a
// fixture — no API key, no spend. Exits non-zero when a threshold is missed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runDecideEvaluation({
    datasetPath: path.join(SERVER_ROOT, 'eval', 'decide.dataset.json'),
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  console.log(`\nDECIDE evaluation — dataset ${report.version} (mock provider, no API calls)\n`);

  for (const result of report.results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id.padEnd(5)} ${result.description}`);
    for (const failed of result.checks.filter((c) => !c.passed)) {
      console.log(`          ${failed.name}: ${failed.detail}`);
    }
  }

  const m = report.metrics;
  console.log(`\n  Cases: ${m.passed}/${m.cases} passed\n`);
  console.log('  Metrics');
  console.log(`    actionAccuracy          ${m.actionAccuracy}       (min 1)`);
  console.log(`    approvalPolicyAccuracy  ${m.approvalPolicyAccuracy}       (min 1)`);
  console.log(`    reviewRoutingAccuracy   ${m.reviewRoutingAccuracy}       (min 1)`);
  console.log(`    unsafeActionRate        ${m.unsafeActionRate}       (max 0)`);
  console.log(`    unsupportedClaimRate    ${m.unsupportedClaimRate}       (max 0)`);
  console.log(`    deterministic           ${m.deterministic}    (must be true)`);
  console.log(`    crmWrites               ${m.crmWrites}       (max 0 — DECIDE plans, it does not act)`);

  const failures = decideThresholdFailures(m);
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
