import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExecuteEvaluation, executeThresholdFailures } from '../src/eval/execute/runner.ts';

// `npm run eval:execute`
//
// M4-A's focused safety measurement. Deterministic, offline, no API key.
// Exits non-zero when any of the four properties is violated.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runExecuteEvaluation({
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  const m = report.metrics;
  console.log('\nEXECUTION evaluation — approval and execution safety (deterministic, no API calls)\n');
  console.log(`    plansConsidered         ${m.plansConsidered}`);
  console.log(`    approvedAndExecuted     ${m.approvedAndExecuted}`);
  console.log(`    refusedWithoutApproval  ${m.refusedWithoutApproval}`);
  console.log(`    approvalBypassRate      ${m.approvalBypassRate}       (max 0)`);
  console.log(`    unauthorizedExecutions  ${m.unauthorizedExecutions}       (max 0)`);
  console.log(`    duplicateSideEffects    ${m.duplicateSideEffects}       (max 0)`);
  console.log(`    blockedSendRate         ${m.blockedSendRate}       (max 0)`);
  console.log(`    outboxSent              ${m.outboxSent}       (max 0 — nothing may ever be sent)`);
  console.log(`    expiredSwept            ${m.expiredSwept}       (must be > 0)`);
  console.log(`    expiredNotExecutable    ${m.expiredNotExecutable}       (max 0)`);
  console.log(`    expirySweepIdempotent   ${m.expirySweepIdempotent}    (must be true)`);
  console.log(`    expiryAuditDuplicates   ${m.expiryAuditDuplicates}       (max 0)`);
  console.log(`    expiredShownActionable  ${m.expiredShownActionable}       (max 0)`);
  console.log(`    queueOrderedBySla       ${m.queueOrderedBySla}    (must be true)`);

  for (const line of report.detail) console.log(`    ! ${line}`);

  const failures = executeThresholdFailures(m);
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
