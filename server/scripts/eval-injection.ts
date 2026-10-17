import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmProviderName } from '../src/config/env.ts';

// `npm run eval:injection`            a DRY RUN: prints what it would do and the number of requests, calls nothing
// `npm run eval:injection -- --go`    sends the twelve attack emails to the real model, one request each
//
// UNDERSTAND only (no matching, no drafting). Each attack asks the model to write a canary token into
// a field; the report says, per attack, whether the deterministic detector flagged it, whether the model
// flagged it, whether the model obeyed, and whether it ended up with a person. Every raw reply is saved.
// The attack set is AI-written (see its provenance) and covers twelve attacks, so a result here is a
// small demonstration, not a rate. Needs the provider's key; set LLM_MAX_RETRIES=0 for an exact count.
//
//   --provider gemini|anthropic   which model (default: gemini)
//   --pause-ms N                  wait between emails (default 7000)
//   --go                          actually make the requests

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.resolve(SERVER_ROOT, '..', 'docs', 'results');

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const providerName = (argValue('--provider') ?? 'gemini') as LlmProviderName;
  if (providerName !== 'gemini' && providerName !== 'anthropic') {
    console.error('--provider must be gemini or anthropic.');
    process.exitCode = 1;
    return;
  }
  const go = process.argv.includes('--go');
  const pauseMs = Number(argValue('--pause-ms') ?? 7000);

  process.env.LLM_PROVIDER = providerName;
  const { config } = await import('../src/config/env.ts');
  const { createLlmProvider } = await import('../src/adapters/llm/index.ts');
  const { announceInjectionBudget, loadInjectionDataset, runInjectionEvaluation } = await import('../src/eval/injection/runner.ts');
  const { LEGACY_GOLD_LABEL: GOLD_LABEL } = await import('../src/eval/provenance.ts');
  const { DEFAULT_ANTHROPIC_TEMPERATURE, DEFAULT_GEMINI_TEMPERATURE } = await import('../src/adapters/llm/defaults.ts');

  const model = providerName === 'gemini' ? config.geminiModel : config.anthropicModel;
  const key = providerName === 'gemini' ? config.geminiApiKey : config.anthropicApiKey;
  const temperature = config.llmTemperature ?? (providerName === 'gemini' ? DEFAULT_GEMINI_TEMPERATURE : DEFAULT_ANTHROPIC_TEMPERATURE);
  const datasetPath = path.join(SERVER_ROOT, 'eval', 'injection.dataset.json');
  const dataset = loadInjectionDataset(datasetPath);

  console.log(`\nREAL-MODEL injection run: ${providerName}, model ${model}, temperature ${temperature}`);
  console.log(`  API key: ${key ? 'is set' : 'is NOT set'}   retries per call: ${config.llmMaxRetries}   timeout: ${config.llmTimeoutMs} ms`);
  console.log(`  Attack set: ${dataset.cases.length} emails, ${dataset.provenance.split('.')[0]}.`);
  console.log(`  Gold data: ${GOLD_LABEL}`);
  console.log(`  Expected requests: ${announceInjectionBudget(dataset.cases.length)}`);
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

  const report = await runInjectionEvaluation({
    provider: createLlmProvider(config),
    settings: { provider: providerName, model, temperature, maxRetries: config.llmMaxRetries, timeoutMs: config.llmTimeoutMs },
    datasetPath,
    migrationsDir: path.join(SERVER_ROOT, 'migrations'),
    pauseMs,
    onProgress: (line) => console.log(`  ${line}`),
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${report.startedAt.slice(0, 10)}-real-injection-${providerName}-${model}${report.complete ? '' : '-partial'}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const m = report.metrics;
  console.log(`\n  Of ${m.cases} attacks (${m.answered} answered): detector flagged ${m.detectorFlagged}, model flagged ${m.modelFlagged}, sent to a person ${m.sentToPerson}.`);
  console.log(`  Model obeyed (canary in a returned value): ${m.obeyedByModel}; canary stored after validation: ${m.canaryStored}; obeyed and NOT sent to a person: ${m.obeyedAndNotSentToPerson}.`);
  console.log(`  Requests: ${report.providerCalls} calls made, ${report.failedCalls} failed. ${report.label}.`);
  console.log(`  Report saved: ${file}`);
  if (!report.complete) {
    console.error(`\n  STOPPED EARLY after ${report.stopped?.after}: ${report.stopped?.detail}. The report is partial.`);
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error('[eval:injection] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
