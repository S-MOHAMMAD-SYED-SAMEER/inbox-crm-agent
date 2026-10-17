import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmResponse } from '../src/adapters/llm/index.ts';

// `npm run rescore:real -- <report.json> [--fill <rerun.json>] [--save <out.json>]`
//
// Re-runs a SAVED real-model report through the CURRENT code, offline: the model's raw replies are
// replayed, nothing is sent anywhere, no key is read, no request is made. It answers "what would
// these exact replies score now that the code around the model changed?", and prints the saved
// (before) numbers next to the replayed (after) ones.
//
// It works on both kinds of report: the ten-email evaluation and the twelve-attack injection run.
// `--fill` supplies replies for requests that failed in the saved run (a draft that got a 503 and
// was asked again later): its calls are used only where the saved run has no reply.
//
// `--understand-dataset` and `--decide-dataset` score against other copies of the datasets (for example the
// first, unreviewed versions from git history), so the same replies can be scored against the old and the new gold.
// The label printed and saved is the one the dataset itself declares (`goldLabel`); a dataset without one is the
// unreviewed original.
//
// What it cannot tell you: what the model would say to a CHANGED prompt. That needs a real request.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

type Call = import('../src/eval/real/runner.ts').RecordedCall;

async function main(): Promise<void> {
  const reportPath = process.argv[2];
  if (!reportPath || reportPath.startsWith('--')) {
    console.error('usage: npm run rescore:real -- <report.json> [--fill <rerun.json>] [--save <out.json>]');
    process.exitCode = 1;
    return;
  }
  const saved = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const { createReplayProvider, replayKey } = await import('../src/eval/real/replay.ts');
  const { GOLD_LABEL, LEGACY_GOLD_LABEL } = await import('../src/eval/provenance.ts');

  const fill = new Map<string, LlmResponse>();
  const fillPath = argValue('--fill');
  if (fillPath) {
    const extra = JSON.parse(fs.readFileSync(fillPath, 'utf8')) as { calls?: Call[]; results?: Array<{ calls: Call[] }> };
    const extraCalls = extra.calls ?? (extra.results ?? []).flatMap((r) => r.calls);
    for (const call of extraCalls) if (call.ok && call.response) fill.set(replayKey(call.fixtureId, call.purpose), call.response);
  }

  const understandPath = argValue('--understand-dataset') ?? path.join(SERVER_ROOT, 'eval', 'understand.dataset.json');
  const decidePath = argValue('--decide-dataset') ?? path.join(SERVER_ROOT, 'eval', 'decide.dataset.json');
  const goldOf = (file: string): { version: string; goldLabel?: string } => JSON.parse(fs.readFileSync(file, 'utf8'));
  const goldLabel = goldOf(understandPath).goldLabel ?? LEGACY_GOLD_LABEL;
  void GOLD_LABEL;
  console.log(`\nOFFLINE RE-SCORE of ${path.basename(reportPath)} (no request is made).`);
  console.log(`  Gold: ${goldLabel} (${goldOf(understandPath).version}, ${goldOf(decidePath).version})`);
  console.log(`  Saved run: ${saved.settings.provider} ${saved.settings.model}, temperature ${saved.settings.temperature}, ${saved.providerCalls} requests, ${saved.failedCalls} failed.`);

  let after: unknown;
  if (saved.kind === 'real-evaluation') {
    const { runRealEvaluation } = await import('../src/eval/real/runner.ts');
    const calls: Call[] = (saved.items as Array<{ calls: Call[] }>).flatMap((item) => item.calls);
    const report = await runRealEvaluation({
      provider: createReplayProvider(calls, { fill }),
      settings: saved.settings,
      understandDatasetPath: understandPath,
      decideDatasetPath: decidePath,
      goldLabel,
      demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
      migrationsDir: path.join(SERVER_ROOT, 'migrations'),
    });
    after = report;
    const rows: Array<[string, unknown, unknown]> = [];
    // Metrics are listed by the UNION of the saved and the replayed names, so a metric that was split or renamed shows on
    // both sides: the old name with no replayed value, the new names with no saved one.
    const union = (a: object, b: object): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of union(saved.understand.metrics, report.understand.metrics)) rows.push([`UNDERSTAND ${key}`, saved.understand.metrics[key] ?? '-', (report.understand.metrics as Record<string, unknown>)[key] ?? '-']);
    for (const key of union(saved.decide.metrics, report.decide.metrics)) rows.push([`DECIDE ${key}`, saved.decide.metrics[key] ?? '-', (report.decide.metrics as Record<string, unknown>)[key] ?? '-']);
    console.log(`  ${'metric'.padEnd(36)}${'before'.padEnd(10)}after`);
    for (const [name, before, now] of rows) console.log(`  ${name.padEnd(36)}${String(before).padEnd(10)}${String(now)}${before === now ? '' : '   <- changed'}`);
    if ('hallucinatedFieldRate' in saved.understand.metrics) {
      console.log('  (hallucinatedFieldRate is the old combined name: it counted a value the email never contains and a value the email does contain but the gold did not expect as the same thing. It is now split into inventedFieldRate and extraFieldRate.)');
    }
    const changed = (report.understand.results as Array<{ id: string; passed: boolean }>).filter((r, i) => r.passed !== saved.understand.results[i]?.passed);
    console.log(`  UNDERSTAND cases whose pass/fail changed: ${changed.map((c) => c.id).join(', ') || 'none'}`);
    const dchanged = (report.decide.results as Array<{ id: string; passed: boolean }>).filter((r) => r.passed !== saved.decide.results.find((b: { id: string }) => b.id === r.id)?.passed);
    console.log(`  DECIDE cases whose pass/fail changed: ${dchanged.map((c) => c.id).join(', ') || 'none'}`);
    console.log(`  Replayed requests that had no saved reply: ${report.failedCalls}`);
  } else if (saved.kind === 'injection-evaluation') {
    const { runInjectionEvaluation } = await import('../src/eval/injection/runner.ts');
    const calls: Call[] = (saved.results as Array<{ calls: Call[] }>).flatMap((r) => r.calls);
    const report = await runInjectionEvaluation({
      provider: createReplayProvider(calls, { fill }),
      settings: saved.settings,
      datasetPath: path.join(SERVER_ROOT, 'eval', 'injection.dataset.json'),
      migrationsDir: path.join(SERVER_ROOT, 'migrations'),
    });
    after = report;
    console.log(`  ${'metric'.padEnd(28)}${'before'.padEnd(10)}after`);
    for (const key of Object.keys(saved.metrics)) {
      const before = saved.metrics[key];
      const now = (report.metrics as Record<string, number>)[key];
      console.log(`  ${key.padEnd(28)}${String(before).padEnd(10)}${now}${before === now ? '' : '   <- changed'}`);
    }
    for (const r of report.results) {
      const was = saved.results.find((b: { id: string }) => b.id === r.id);
      if (was.detectorFlagged !== r.detectorFlagged || was.sentToPerson !== r.sentToPerson) {
        console.log(`  ${r.id} ${r.kind}: detector ${was.detectorFlagged} -> ${r.detectorFlagged} [${r.detectorRules.join(', ')}], sent to a person ${was.sentToPerson} -> ${r.sentToPerson}`);
      }
    }
  } else {
    console.error(`unknown report kind: ${saved.kind}`);
    process.exitCode = 1;
    return;
  }

  const savePath = argValue('--save');
  if (savePath) {
    fs.writeFileSync(savePath, `${JSON.stringify({ rescoredFrom: path.basename(reportPath), offline: true, ...(after as object) }, null, 2)}\n`, 'utf8');
    console.log(`  Saved: ${savePath}`);
  }
}

main().catch((err: unknown) => {
  console.error('[rescore:real] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
