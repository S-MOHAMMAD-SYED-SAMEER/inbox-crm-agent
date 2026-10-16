import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmProviderName } from '../src/config/env.ts';

// `npm run eval:real`            a DRY RUN: prints what it would do and the number of requests, calls nothing
// `npm run eval:real -- --go`    runs the real evaluation against the real model
//
// Runs the ten demo emails through the real pipeline (read, match, decide, draft) with a REAL model in
// place of the scripted one, scores the result with the same checks the mock evaluations use, and saves
// every raw model reply. Needs the provider's key.
//
//   --provider gemini|anthropic   which model (default: gemini)
//   --pause-ms N                  wait between emails (default 7000, to stay under a free tier's per-minute limit)
//   --go                          actually make the requests. Without it nothing is called.
//
// It prints the expected number of requests before it starts and stops at once on a rate-limit or quota
// error, or when two different emails fail in a row. For a counted run set LLM_MAX_RETRIES=0 so the
// adapter does not add retries of its own. The report says "scored against AI-written gold" because it is.
//
// Phase 3a built this and did NOT run it: running it needs the owner's go-ahead.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.resolve(SERVER_ROOT, '..', 'docs', 'results');

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const providerName = (argValue('--provider') ?? 'gemini') as LlmProviderName;
  if (providerName !== 'gemini' && providerName !== 'anthropic') {
    console.error('--provider must be gemini or anthropic. The mock evaluations are `npm run eval:understand` and the others.');
    process.exitCode = 1;
    return;
  }
  const go = process.argv.includes('--go');
  const pauseMs = Number(argValue('--pause-ms') ?? 7000);

  // The provider is forced before the configuration is read (and `.env` is loaded there).
  process.env.LLM_PROVIDER = providerName;
  const { config } = await import('../src/config/env.ts');
  const { createLlmProvider } = await import('../src/adapters/llm/index.ts');
  const { announceBudget, draftCount, runRealEvaluation } = await import('../src/eval/real/runner.ts');
  const { loadDataset } = await import('../src/eval/understand/runner.ts');
  const { loadDecideDataset } = await import('../src/eval/decide/runner.ts');
  const { GOLD_LABEL } = await import('../src/eval/provenance.ts');
  const { DEFAULT_ANTHROPIC_TEMPERATURE, DEFAULT_GEMINI_TEMPERATURE } = await import('../src/adapters/llm/defaults.ts');

  const model = providerName === 'gemini' ? config.geminiModel : config.anthropicModel;
  const key = providerName === 'gemini' ? config.geminiApiKey : config.anthropicApiKey;
  const temperature = config.llmTemperature ?? (providerName === 'gemini' ? DEFAULT_GEMINI_TEMPERATURE : DEFAULT_ANTHROPIC_TEMPERATURE);

  const understandPath = path.join(SERVER_ROOT, 'eval', 'understand.dataset.json');
  const decidePath = path.join(SERVER_ROOT, 'eval', 'decide.dataset.json');
  const budget = announceBudget(loadDataset(understandPath).cases.length, draftCount(loadDecideDataset(decidePath).cases));

  console.log(`\nREAL-MODEL evaluation: ${providerName}, model ${model}, temperature ${temperature}`);
  console.log(`  API key: ${key ? 'is set' : 'is NOT set'}   retries per call: ${config.llmMaxRetries}   timeout: ${config.llmTimeoutMs} ms`);
  console.log(`  Gold data: ${GOLD_LABEL}`);
  console.log(`  Expected requests: ${budget.note}`);
  console.log(`  Pause between emails: ${pauseMs} ms. Stops at once on a 429 / quota error, or when two different emails fail in a row.`);

  if (!go) {
    console.log('\n  DRY RUN: nothing was called. Add --go to make these requests.\n');
    return;
  }
  if (!key) {
    console.error(`\n  Not starting: the ${providerName} API key is not set (see server/.env.example).`);
    process.exitCode = 1;
    return;
  }

  const report = await runRealEvaluation({
    provider: createLlmProvider(config),
    settings: { provider: providerName, model, temperature, maxRetries: config.llmMaxRetries, timeoutMs: config.llmTimeoutMs },
    understandDatasetPath: understandPath,
    decideDatasetPath: decidePath,
    demoDataDir: path.join(SERVER_ROOT, 'data', 'demo'),
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
    pauseMs,
    onProgress: (line) => console.log(`  ${line}`),
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const day = report.startedAt.slice(0, 10);
  const file = path.join(RESULTS_DIR, `${day}-real-eval-${providerName}-${model}${report.complete ? '' : '-partial'}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const u = report.understand.metrics;
  const d = report.decide.metrics;
  console.log(`\n  UNDERSTAND: ${u.passed}/${u.cases} cases passed; categoryAccuracy ${u.categoryAccuracy}, priorityAccuracy ${u.priorityAccuracy}, extractionF1 ${u.extractionF1}, hallucinatedFieldRate ${u.hallucinatedFieldRate}, injectionContainment ${u.injectionContainment}`);
  console.log(`  DECIDE:     ${d.passed}/${d.cases} cases passed; actionAccuracy ${d.actionAccuracy}, approvalPolicyAccuracy ${d.approvalPolicyAccuracy}, unsafeActionRate ${d.unsafeActionRate}, unsupportedClaimRate ${d.unsupportedClaimRate}, crmWrites ${d.crmWrites}`);
  console.log(`  Requests: ${report.providerCalls} calls made, ${report.failedCalls} failed. Gold data: ${report.label}.`);
  for (const f of [...report.understand.thresholdFailures, ...report.decide.thresholdFailures]) console.log(`  below threshold: ${f}`);
  console.log(`  Report saved: ${file}`);

  if (!report.complete) {
    console.error(`\n  STOPPED EARLY after ${report.stopped?.after}: ${report.stopped?.detail}. The report is partial.`);
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error('[eval:real] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
