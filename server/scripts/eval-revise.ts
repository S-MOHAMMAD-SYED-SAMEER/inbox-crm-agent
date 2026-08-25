import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviseEvaluation, reviseThresholdFailures } from '../src/eval/revise/runner.ts';

// `npm run eval:revise`
//
// M4-C's focused safety measurement: the human revision lifecycle.
// Deterministic, offline, no API key. Exits non-zero when any property is
// violated — or when one of them was never exercised.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const report = await runReviseEvaluation({
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
  });

  const m = report.metrics;
  console.log('\nREVISION evaluation — human-in-the-loop safety (deterministic, no API calls)\n');

  console.log(`    revisionAttempts             ${m.revisionAttempts}       (min 3)`);
  console.log(`    revisionSuccess              ${m.revisionSuccess}/${m.revisionAttempts}`);
  console.log(`    originalPreserved            ${m.originalPreserved}/${m.revisionSuccess}`);
  console.log(`    supersededCorrectly          ${m.supersededCorrectly}/${m.revisionSuccess}`);
  console.log(`    newApprovalPending           ${m.newApprovalPending}/${m.revisionSuccess}`);
  console.log(`    fingerprintChanged           ${m.fingerprintChanged}/${m.revisionSuccess}`);
  console.log(`    executableOnlyAfterApproval  ${m.executableOnlyAfterApproval}/${m.revisionSuccess}`);
  console.log(`    duplicateSideEffects         ${m.duplicateSideEffects}       (max 0)`);
  console.log('');
  console.log(`    approvalPolicyPreserved      ${m.approvalPolicyPreserved}/${m.policyAttempts}   (attempts must be > 0)`);
  console.log(`    unsafeEditBlocked            ${m.unsafeEditBlocked}/${m.unsafeEditAttempts}   (all six guardrails)`);
  console.log(`    atomicRollback               ${m.atomicRollback}/${m.rollbackAttempts}   (attempts must be > 0)`);
  console.log(`    expiredRevisionNotExecutable ${m.expiredRevisionNotExecutable}/${m.expiryAttempts}   (attempts must be > 0)`);
  console.log('');
  console.log(`    auditIntegrity               ${m.auditIntegrity}    (must be true)`);
  console.log(`    outboxSent                   ${m.outboxSent}       (max 0 — nothing may ever be sent)`);

  for (const line of report.detail) console.log(`    ! ${line}`);

  const failures = reviseThresholdFailures(m);
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
