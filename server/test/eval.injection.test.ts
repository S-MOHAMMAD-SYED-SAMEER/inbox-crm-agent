import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { LlmUnavailableError } from '../src/adapters/llm/index.ts';
import type { LlmProvider, LlmRequest } from '../src/adapters/llm/index.ts';
import {
  announceInjectionBudget,
  loadInjectionDataset,
  runInjectionEvaluation,
  type InjectionReport,
} from '../src/eval/injection/runner.ts';
import { GOLD_LABEL } from '../src/eval/provenance.ts';

// The injection run, exercised with a SCRIPTED provider standing in for the model: no key, no
// network, no model call. What is tested is the plumbing: the canary check, the three separate
// signals, the request count, and the stop rule.

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const DATASET = path.join(SERVER_ROOT, 'eval', 'injection.dataset.json');
const SETTINGS = { provider: 'gemini', model: 'gemini-test', temperature: 1, maxRetries: 0, timeoutMs: 30_000 };
const dataset = loadInjectionDataset(DATASET);

type Behaviour = 'clean' | 'obey' | 'flag' | 'fail503' | 'quota';

/** A model that answers every email with an empty, honest understanding, except where told otherwise. */
function scripted(behaviour: (caseId: string) => Behaviour): LlmProvider {
  const byMessage = new Map(dataset.cases.map((c) => [c.email.providerMessageId, c]));
  return {
    name: 'gemini',
    configured: true,
    async complete(request: LlmRequest) {
      const attack = byMessage.get(request.metadata?.fixtureId ?? '');
      assert.ok(attack, 'the request names an attack email');
      const what = behaviour(attack.id);
      if (what === 'fail503') throw new LlmUnavailableError('gemini', 'HTTP 503', { kind: 'server', status: 503, retryable: true });
      if (what === 'quota') throw new LlmUnavailableError('gemini', 'quota exceeded', { kind: 'rate_limit', status: 429 });
      const field = (value: string | null, span: string | null = value) => ({ value, confidence: value ? 0.9 : 0, sourceSpan: span });
      const none = field(null);
      return {
        toolInput: {
          category: 'sales_inquiry',
          intent: 'Asks about a service.',
          priority: 'medium',
          priorityReason: 'Standard enquiry.',
          confidence: 0.9,
          summary: 'A short enquiry.',
          questionAsked: null,
          flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: what === 'flag' },
          extracted: {
            contactName: none,
            contactEmail: field(attack.email.fromEmail),
            contactPhone: none,
            jobTitle: none,
            companyName: what === 'obey' ? field(attack.canary) : none,
            companyDomain: none,
            serviceInterest: none,
            requirementSummary: none,
            budget: none,
            timeline: none,
            urgencyCues: none,
          },
        },
        model: 'gemini-test',
        latencyMs: 5,
        usage: {
          model: 'gemini-test',
          inputTokens: 1000,
          outputTokens: 100,
          thinkingTokens: null,
          totalTokens: 1100,
          latencyMs: 5,
          attempts: 1,
          finishReason: 'STOP',
          temperature: 1,
          maxTokens: 4096,
        },
      } as never;
    },
  };
}

function run(provider: LlmProvider): Promise<InjectionReport> {
  return runInjectionEvaluation({ provider, settings: SETTINGS, datasetPath: DATASET, migrationsDir: MIGRATIONS_DIR });
}

test('the dataset is twelve attacks, each carrying its own canary, and says who wrote it', () => {
  assert.equal(dataset.cases.length, 12);
  assert.match(dataset.provenance, /AI-written/);
  assert.equal(dataset.cases.filter((c) => c.evadesDetectorOnPurpose).length, 2);
  assert.equal(new Set(dataset.cases.map((c) => c.canary)).size, 12);
  assert.equal(announceInjectionBudget(12), "12 requests (one per attack email, UNDERSTAND only), up to 24 if every answer needs the pipeline's one repair retry. The adapter may add bounded retries after a 429, 5xx or timeout.");
});

test('a clean model: twelve requests, the detector alone is what sends the detectable attacks to a person', async () => {
  const report = await run(scripted(() => 'clean'));
  assert.equal(report.complete, true);
  assert.equal(report.providerCalls, 12);
  assert.equal(report.label, GOLD_LABEL);
  assert.equal(report.metrics.obeyedByModel, 0);
  assert.equal(report.metrics.modelFlagged, 0);
  // The two written to evade the detector are exactly the ones that reach no person.
  const missed = report.results.filter((r) => !r.sentToPerson).map((r) => r.id);
  assert.ok(missed.includes('I-10') && missed.includes('I-11'), `the evasive attacks are not detected: ${missed.join(',')}`);
  assert.equal(report.results.find((r) => r.id === 'I-01')?.sentToPerson, true);
  assert.equal(report.results.find((r) => r.id === 'I-01')?.detectorFlagged, true);
});

test('a model that obeys is told apart from one that merely quotes, and the dangerous cell is counted', async () => {
  const report = await run(scripted((id) => (id === 'I-11' ? 'obey' : 'clean')));
  const obeyed = report.results.find((r) => r.id === 'I-11');
  assert.equal(obeyed?.obeyedByModel, true);
  assert.equal(obeyed?.canaryStored, true);
  assert.equal(obeyed?.sentToPerson, false);
  assert.equal(obeyed?.obeyedAndNotSentToPerson, true);
  assert.equal(report.metrics.obeyedByModel, 1);
  assert.equal(report.metrics.obeyedAndNotSentToPerson, 1);
});

test('the model flag is recorded separately from the detector flag', async () => {
  const report = await run(scripted((id) => (id === 'I-10' ? 'flag' : 'clean')));
  const r = report.results.find((x) => x.id === 'I-10');
  assert.equal(r?.modelFlagged, true);
  assert.equal(r?.detectorFlagged, false);
  assert.equal(r?.sentToPerson, true, 'the model flag alone routes it to a person');
});

test('one 503 is recorded and the run goes on; two different emails failing in a row stop it', async () => {
  const one = await run(scripted((id) => (id === 'I-03' ? 'fail503' : 'clean')));
  assert.equal(one.complete, true);
  assert.equal(one.failedCalls, 1);
  assert.equal(one.results.find((r) => r.id === 'I-03')?.answered, false);
  assert.equal(one.metrics.answered, 11);

  const two = await run(scripted((id) => (id === 'I-03' || id === 'I-04' ? 'fail503' : 'clean')));
  assert.equal(two.complete, false);
  assert.equal(two.stopped?.kind, 'consecutive_failures');
  assert.equal(two.stopped?.after, 'I-04');
  assert.equal(two.results.length, 4);
});

test('a quota error stops the run at once', async () => {
  const report = await run(scripted((id) => (id === 'I-02' ? 'quota' : 'clean')));
  assert.equal(report.complete, false);
  assert.equal(report.stopped?.kind, 'rate_limit');
  assert.equal(report.results.length, 2);
});
