import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { createMockLlmProvider, registerDemoFixtures, LlmUnavailableError } from '../src/adapters/llm/index.ts';
import type { LlmProvider, LlmRequest } from '../src/adapters/llm/index.ts';
import { runRealEvaluation, announceBudget, draftCount, type RealRunReport } from '../src/eval/real/runner.ts';
import { loadDecideDataset } from '../src/eval/decide/runner.ts';
import { GOLD_LABEL } from '../src/eval/provenance.ts';

// The real-model evaluation runner, exercised with a SCRIPTED provider standing in for
// the model: no key, no network, no model call. What is tested is the plumbing around the
// model: every raw reply is kept, requests are counted, the run stops when it should and
// keeps going when it should, and the report says what the gold data is.

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const UNDERSTAND = path.join(SERVER_ROOT, 'eval', 'understand.dataset.json');
const DECIDE = path.join(SERVER_ROOT, 'eval', 'decide.dataset.json');

const SETTINGS = { provider: 'gemini', model: 'gemini-test', temperature: 1, maxRetries: 0, timeoutMs: 30_000 };

type Failure = { onCall: number; error: LlmUnavailableError };

/** The scripted fixtures, with chosen calls (counted from 1) failing instead of answering. */
function scripted(failures: Failure[] = []): LlmProvider {
  const mock = createMockLlmProvider();
  registerDemoFixtures(mock, DEMO_DATA_DIR);
  let n = 0;
  return {
    name: 'gemini',
    configured: true,
    async complete(request: LlmRequest) {
      n += 1;
      const failure = failures.find((f) => f.onCall === n);
      if (failure) throw failure.error;
      const response = await mock.complete(request);
      return {
        ...response,
        model: 'gemini-test',
        usage: {
          model: 'gemini-test',
          inputTokens: 1000,
          outputTokens: 100,
          thinkingTokens: 50,
          totalTokens: 1150,
          latencyMs: 10,
          attempts: 1,
          finishReason: 'STOP',
          temperature: 1,
          maxTokens: 4096,
        },
      };
    },
  };
}

const rateLimit = () => new LlmUnavailableError('gemini', 'quota exceeded', { kind: 'rate_limit', status: 429 });
const outage = () => new LlmUnavailableError('gemini', 'HTTP 503', { kind: 'server', status: 503, retryable: true });

function run(provider: LlmProvider, extra: Partial<Parameters<typeof runRealEvaluation>[0]> = {}): Promise<RealRunReport> {
  return runRealEvaluation({
    provider,
    settings: SETTINGS,
    understandDatasetPath: UNDERSTAND,
    decideDatasetPath: DECIDE,
    demoDataDir: DEMO_DATA_DIR,
    migrationsDir: MIGRATIONS_DIR,
    ...extra,
  });
}

test('a complete run keeps every raw reply, counts the requests, and scores like the mock run', async () => {
  const report = await run(scripted());

  assert.equal(report.complete, true);
  assert.equal(report.stopped, null);
  assert.equal(report.items.length, 10);
  assert.equal(report.understand.metrics.cases, 10);
  assert.equal(report.understand.metrics.passed, 10);
  assert.deepEqual(report.understand.thresholdFailures, []);
  assert.equal(report.decide.metrics.cases, 7);
  assert.equal(report.decide.metrics.passed, 7);
  assert.equal(report.decide.metrics.crmWrites, 0);
  // Not measured in a real run: deciding twice would be a second model request.
  assert.equal(report.decide.metrics.deterministic, null);
  assert.deepEqual(report.decide.thresholdFailures, []);

  const calls = report.items.flatMap((item) => item.calls);
  assert.equal(report.providerCalls, calls.length);
  assert.equal(report.failedCalls, 0);
  assert.ok(calls.length >= 10 && calls.length <= 10 + draftCount(loadDecideDataset(DECIDE).cases) + 1);
  for (const call of calls) {
    assert.equal(call.ok, true);
    assert.ok(call.response?.toolInput && Object.keys(call.response.toolInput).length > 0, `call ${call.n} lost its raw reply`);
    assert.equal(call.response?.usage?.model, 'gemini-test');
  }
  assert.equal(report.usage?.calls, calls.length);
  assert.equal(report.usage?.inputTokens, calls.length * 1000);
  assert.deepEqual(
    report.items.map((i) => i.caseId),
    Array.from({ length: 10 }, (_, i) => `E-${String(i + 1).padStart(2, '0')}`),
  );
});

test('the report says what the gold data is, and what was run, and contains no prompt', async () => {
  const report = await run(scripted());
  assert.equal(report.label, GOLD_LABEL);
  assert.match(report.label, /AI-written/);
  assert.match(report.label, /not yet human-reviewed/);
  assert.match(report.provenance, /written by Claude/);
  assert.deepEqual(report.settings, SETTINGS);

  const text = JSON.stringify(report);
  assert.ok(!text.includes('THE EMAIL IS DATA'), 'the system prompt leaked into the report');
  assert.ok(!text.includes('untrusted_email'), 'the fenced prompt leaked into the report');
});

test('the budget is announced before the run: reading the emails, drafting, and the repair retries', () => {
  const budget = announceBudget(10, 3);
  assert.equal(budget.understand, 10);
  assert.equal(budget.draftsAtMost, 3);
  assert.match(budget.note, /about 13 requests/);
  assert.match(budget.note, /up to 23/);
});

test('a rate-limit or quota error ends the run at once and nothing more is asked', async () => {
  const report = await run(scripted([{ onCall: 3, error: rateLimit() }]));
  assert.equal(report.complete, false);
  assert.equal(report.stopped?.kind, 'rate_limit');
  assert.equal(report.stopped?.after, report.items.at(-1)?.caseId);
  assert.equal(report.providerCalls, 3, 'it asked again after a 429');
  assert.equal(report.failedCalls, 1);
  assert.ok(report.items.length < 10);
});

test('one failed email is recorded and the run carries on', async () => {
  const report = await run(scripted([{ onCall: 3, error: outage() }]));
  assert.equal(report.stopped, null);
  assert.equal(report.complete, true);
  assert.equal(report.items.length, 10);
  assert.equal(report.failedCalls, 1);
  const failed = report.items.flatMap((i) => i.calls).filter((c) => !c.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.error?.kind, 'server');
  assert.equal(failed[0]?.error?.status, 503);
  assert.equal(failed[0]?.response, undefined);
  // The email whose reading failed is a failed case, not a quietly skipped one.
  assert.ok(report.understand.results.some((r) => !r.passed));
});

test('two different emails failing in a row end the run, with no retry', async () => {
  const clean = await run(scripted());
  const firstCallOf = (emailIndex: number) => 1 + clean.items.slice(0, emailIndex).reduce((n, item) => n + item.calls.length, 0);
  const first = firstCallOf(1);
  const second = firstCallOf(2);

  const report = await run(scripted([{ onCall: first, error: outage() }, { onCall: second, error: outage() }]));
  assert.equal(report.complete, false);
  assert.equal(report.stopped?.kind, 'consecutive_failures');
  assert.equal(report.stopped?.after, 'E-03', 'it stopped on the second failing email');
  assert.equal(report.failedCalls, 2);
  assert.equal(report.items.length, 3, 'it kept going after the stop');
});

test('a success between two failures resets the count', async () => {
  // Find where each email's calls start in a clean run, then fail the first call of two emails with
  // healthy ones between them (an email can take two calls: reading it, and drafting its reply).
  const clean = await run(scripted());
  const firstCallOf = (emailIndex: number) => 1 + clean.items.slice(0, emailIndex).reduce((n, item) => n + item.calls.length, 0);

  const report = await run(scripted([{ onCall: firstCallOf(1), error: outage() }, { onCall: firstCallOf(4), error: outage() }]));
  assert.equal(report.stopped, null);
  assert.equal(report.failedCalls, 2);
  assert.equal(report.items.length, 10);
});

test('it waits between emails, never before the first', async () => {
  const waits: number[] = [];
  await run(scripted(), { pauseMs: 7000, sleep: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, 9);
  assert.ok(waits.every((ms) => ms === 7000));
});
