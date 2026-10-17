import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { runRealEvaluation, type RealRunReport } from '../src/eval/real/runner.ts';
import { summariseRuns } from '../src/eval/real/variance.ts';

// Variance across repeated runs: min / median / max per metric, and per case how often it passed, which category it got and
// whether it reached a person. Built from real pipeline runs against the scripted stand-in for the model (no key, no network).

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const SETTINGS = { provider: 'gemini', model: 'gemini-test', temperature: 1, maxRetries: 0, timeoutMs: 30_000 };

async function oneRun(): Promise<RealRunReport> {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return runRealEvaluation({
    provider,
    settings: SETTINGS,
    understandDatasetPath: path.join(SERVER_ROOT, 'eval', 'understand.dataset.json'),
    decideDatasetPath: path.join(SERVER_ROOT, 'eval', 'decide.dataset.json'),
    demoDataDir: DEMO_DATA_DIR,
    migrationsDir: MIGRATIONS_DIR,
  });
}

test('identical runs have min = median = max, and every case is counted in every run', async () => {
  const runs = [await oneRun(), await oneRun(), await oneRun()];
  const summary = summariseRuns(runs);
  assert.equal(summary.runs, 3);
  assert.equal(summary.completeRuns, 3);
  assert.equal(summary.requests, runs.reduce((sum, run) => sum + run.providerCalls, 0));
  for (const [name, v] of Object.entries(summary.understand)) {
    assert.equal(v.min, v.max, `${name} varies between identical runs`);
    assert.equal(v.median, v.min);
    assert.equal(v.values.length, 3);
  }
  assert.ok('inventedFieldRate' in summary.understand && 'extraFieldRate' in summary.understand);
  assert.ok('actionAccuracy' in summary.decide);
  assert.ok(!('deterministic' in summary.decide), 'a null metric is not summarised');
  const e08 = summary.cases.find((c) => c.id === 'E-08');
  assert.equal(e08?.reachedPerson, 3, 'the ambiguous email reaches a person in every run');
  assert.deepEqual(e08?.categories, ['ambiguous', 'ambiguous', 'ambiguous']);
  assert.equal(summary.cases.find((c) => c.id === 'E-05')?.decidePassed, 3);
  assert.equal(summary.cases.find((c) => c.id === 'E-10')?.decidePassed, null, 'E-10 is not a decide case');
});

test('runs that differ show a spread, and a case that reaches a person in only some runs is counted exactly', async () => {
  const good = await oneRun();
  const worse = structuredClone(good);
  worse.understand.metrics.categoryAccuracy = 0.5;
  const worst = structuredClone(good);
  worst.understand.metrics.categoryAccuracy = 0.7;
  // In one run the ambiguous email slipped through to a later stage.
  const slipped = worse.items.find((item) => item.caseId === 'E-08');
  assert.ok(slipped);
  slipped.understandState = 'resolving';
  worse.failedCalls = 2;

  const summary = summariseRuns([good, worse, worst]);
  const category = summary.understand.categoryAccuracy;
  assert.ok(category);
  assert.equal(category.min, 0.5);
  assert.equal(category.max, 1);
  assert.equal(category.median, 0.7);
  assert.equal(summary.cases.find((c) => c.id === 'E-08')?.reachedPerson, 2);
  assert.equal(summary.failedRequests, 2);
  assert.throws(() => summariseRuns([]), /at least one/);
});
