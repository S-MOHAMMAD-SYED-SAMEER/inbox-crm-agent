import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOutboundEvaluation, outboundThresholdFailures } from '../src/eval/outbound/runner.ts';

// `npm run eval:outbound`
//
// M4-D's focused safety measurement: outbound delivery. Deterministic, offline,
// no API key, no network. Exits non-zero when a protection is violated — or
// when one of them was never exercised.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runOutboundEvaluation({
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  const m = report.metrics;
  console.log('\nOUTBOUND evaluation — delivery safety (deterministic, no network)\n');
  console.log(`    outboundAttempts             ${m.outboundAttempts}       (min 5)`);
  console.log(`    outboundSuccesses            ${m.outboundSuccesses}       (min 2)`);
  console.log(`    outboundFailures             ${m.outboundFailures}       (all four modes)`);
  console.log(`    outboundBlocked              ${m.outboundBlocked}       (min 5)`);
  console.log(`    revisedSendsCorrectVersion   ${m.revisedSendsCorrectVersion}       (min 1)`);
  console.log('');
  console.log(`    unauthorizedOutboundSends    ${m.unauthorizedOutboundSends}/${m.unauthorizedAttempts} attempts   (must be 0)`);
  console.log(`    supersededOutboundSends      ${m.supersededOutboundSends}/${m.supersededAttempts} attempts   (must be 0)`);
  console.log(`    expiredOutboundSends         ${m.expiredOutboundSends}/${m.expiredAttempts} attempts   (must be 0)`);
  console.log(`    fingerprintBypass            ${m.fingerprintBypass}/${m.fingerprintAttempts} attempts   (must be 0)`);
  console.log(`    disabledNetworkCalls         ${m.disabledNetworkCalls}/${m.disabledAttempts} attempts   (must be 0)`);
  console.log(`    duplicateOutboundSends       ${m.duplicateOutboundSends}/${m.duplicateExecutions} attempts   (must be 0)`);
  console.log('');
  console.log(`    auditIntegrity               ${m.auditIntegrity}    (must be true)`);

  for (const line of report.detail) console.log(`    ! ${line}`);

  const failures = outboundThresholdFailures(m);
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
