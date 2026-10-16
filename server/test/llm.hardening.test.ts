import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider, toAnthropicRequest, type AnthropicLike } from '../src/adapters/llm/anthropic.ts';
import { classifyFailure, requestedDelayMs, withRetry } from '../src/adapters/llm/resilience.ts';
import { formatUsage, summarizeUsage } from '../src/adapters/llm/usage.ts';
import { LlmUnavailableError, type LlmRequest, type LlmUsage } from '../src/adapters/llm/types.ts';
import { UNDERSTAND_TOOL } from '../src/agent/understand/schema.ts';
import { loadConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';

// The model adapter's limits and failure handling, with a fake client, a fake sleep
// and a fake clock: no network, no key, no waiting.

const REQUEST: LlmRequest = {
  purpose: 'understand',
  promptVersion: 'understand.v1',
  systemPrompt: 'You read business email.',
  messages: [{ role: 'user', content: 'SECRET-EMAIL-BODY' }],
  tool: UNDERSTAND_TOOL,
  maxTokens: 777,
};

const GOOD = {
  id: 'msg_1',
  model: 'claude-test',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't', name: 'record_understanding', input: { category: 'spam' } }],
  usage: { input_tokens: 120, output_tokens: 30 },
};

/** An SDK-shaped error: a status and headers, like Anthropic.APIError. */
function apiError(status: number, headers: Record<string, string> = {}, name = 'APIError'): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers, name });
}

type Script = Array<Error | Record<string, unknown>>;

function fakeClient(script: Script) {
  const calls: Array<{ params: unknown; options: unknown }> = [];
  const client: AnthropicLike = {
    messages: {
      async create(params, options) {
        calls.push({ params, options });
        const next = script.shift();
        if (next === undefined) throw new Error('the fake client ran out of scripted responses');
        if (next instanceof Error) throw next;
        return next as never;
      },
    },
  };
  return { client, calls };
}

function provider(script: Script, env: Record<string, string> = {}) {
  const { client, calls } = fakeClient(script);
  const sleeps: number[] = [];
  let tick = 0;
  const logs = createMemoryLogger('llm');
  const llm = createAnthropicProvider({
    client,
    cfg: loadConfig({ ...env }).config,
    retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    clock: () => (tick += 250),
    logger: logs.logger,
  });
  return { llm, calls, sleeps, logs };
}

async function failureOf(run: Promise<unknown>): Promise<LlmUnavailableError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof LlmUnavailableError, `expected LlmUnavailableError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to fail');
}

// --- what is sent ------------------------------------------------------------

test('temperature and the output-token cap are explicit on every request', () => {
  const request = toAnthropicRequest(REQUEST, 'm');
  assert.equal(request.temperature, 0.2);
  assert.equal(request.max_tokens, 777);
  assert.equal(toAnthropicRequest(REQUEST, 'm', 0.9).temperature, 0.9);
  assert.equal(toAnthropicRequest({ ...REQUEST, maxTokens: undefined }, 'm').max_tokens, 2048);
});

test('LLM_TEMPERATURE, LLM_TIMEOUT_MS and LLM_MAX_RETRIES are read, validated, and default sensibly', () => {
  const defaults = loadConfig({}).config;
  assert.deepEqual([defaults.llmTimeoutMs, defaults.llmMaxRetries, defaults.llmTemperature], [30_000, 2, null]);
  assert.equal(defaults.geminiModel, 'gemini-3.5-flash-lite');

  const set = loadConfig({ LLM_TIMEOUT_MS: '5000', LLM_MAX_RETRIES: '0', LLM_TEMPERATURE: '0.7' }).config;
  assert.deepEqual([set.llmTimeoutMs, set.llmMaxRetries, set.llmTemperature], [5000, 0, 0.7]);

  const bad = loadConfig({ LLM_TIMEOUT_MS: '-3', LLM_MAX_RETRIES: 'x', LLM_TEMPERATURE: '9' });
  assert.deepEqual([bad.config.llmTimeoutMs, bad.config.llmMaxRetries, bad.config.llmTemperature], [30_000, 2, null]);
  for (const key of ['LLM_TIMEOUT_MS', 'LLM_MAX_RETRIES', 'LLM_TEMPERATURE']) {
    assert.ok(bad.problems.some((problem) => problem.startsWith(key)), `${key} was not reported`);
  }
});

test('each call sends the configured timeout and turns the SDK\'s own retries off', async () => {
  const { llm, calls } = provider([GOOD], { LLM_TIMEOUT_MS: '4000', LLM_TEMPERATURE: '0.5' });
  await llm.complete(REQUEST);
  assert.deepEqual(calls[0]?.options, { timeout: 4000, maxRetries: 0 });
  assert.equal((calls[0]!.params as { temperature: number }).temperature, 0.5);
});

// --- what is recorded --------------------------------------------------------

test('a successful call records tokens, latency, attempts, finish reason, temperature and the cap', async () => {
  const { llm, logs } = provider([GOOD]);
  const response = await llm.complete(REQUEST);

  assert.deepEqual(response.toolInput, { category: 'spam' });
  assert.deepEqual(response.usage, {
    model: 'claude-test',
    inputTokens: 120,
    outputTokens: 30,
    thinkingTokens: null,
    totalTokens: 150,
    latencyMs: 250,
    attempts: 1,
    finishReason: 'tool_use',
    temperature: 0.2,
    maxTokens: 777,
  });
  assert.equal(response.latencyMs, 250);

  const line = logs.entries.find((e) => e.message.includes('call purpose=understand'));
  assert.ok(line, 'no usage line was logged');
  assert.match(line.message, /inputTokens=120 outputTokens=30 totalTokens=150 latencyMs=250 attempts=1 finishReason=tool_use/);
  // Numbers and names only: never the email, the prompt or the reply.
  assert.ok(!JSON.stringify(logs.entries).includes('SECRET-EMAIL-BODY'));
  assert.ok(!JSON.stringify(logs.entries).includes('business email'));
});

test('usage is summed over calls and formatted without any content', () => {
  const one: LlmUsage = { model: 'm', inputTokens: 10, outputTokens: 5, thinkingTokens: 2, totalTokens: 17, latencyMs: 100, attempts: 1, finishReason: 'STOP', temperature: 1, maxTokens: 9 };
  const two: LlmUsage = { ...one, inputTokens: 20, outputTokens: 7, thinkingTokens: null, totalTokens: 27, latencyMs: 300, attempts: 3 };
  assert.deepEqual(summarizeUsage([one, two, undefined]), {
    calls: 2, requests: 4, inputTokens: 30, outputTokens: 12, thinkingTokens: 2, totalTokens: 44, latencyMs: 400,
  });
  assert.equal(summarizeUsage([undefined]), null); // the mock makes no model calls
  assert.match(formatUsage(one, 'draft'), /^purpose=draft model=m temperature=1 maxTokens=9 inputTokens=10/);
});

// --- retries -----------------------------------------------------------------

test('a 429 that asks for a short wait is retried after exactly that wait', async () => {
  const { llm, calls, sleeps } = provider([apiError(429, { 'retry-after': '2' }), GOOD]);
  const response = await llm.complete(REQUEST);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.length, 2);
  assert.equal(response.usage?.attempts, 2, 'the retry must show in the record');
});

test('a 429 that asks for more than 15 s is not retried at all', async () => {
  const { llm, calls, sleeps } = provider([apiError(429, { 'retry-after': '30' }), GOOD]);
  const failure = await failureOf(llm.complete(REQUEST));
  assert.equal(calls.length, 1, 'it waited out a quota instead of failing fast');
  assert.deepEqual(sleeps, []);
  assert.equal(failure.kind, 'rate_limit');
  assert.equal(failure.status, 429);
  assert.equal(failure.retryAfterMs, 30_000);
});

test('a 5xx is retried with backoff and gives up after the configured number of retries', async () => {
  const { llm, calls, sleeps } = provider([apiError(503), apiError(503), apiError(503), GOOD], { LLM_MAX_RETRIES: '2' });
  const failure = await failureOf(llm.complete(REQUEST));
  assert.equal(calls.length, 3, 'one try plus two retries, no more');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1]! > sleeps[0]!, 'backoff should grow');
  assert.equal(failure.kind, 'server');
  assert.equal(failure.retryable, true);
});

test('LLM_MAX_RETRIES=0 means a single attempt', async () => {
  const { llm, calls } = provider([apiError(503), GOOD], { LLM_MAX_RETRIES: '0' });
  await failureOf(llm.complete(REQUEST));
  assert.equal(calls.length, 1);
});

test('a timeout and a dropped connection are retried and named', async () => {
  const timeout = apiError(0, {}, 'APIConnectionTimeoutError');
  delete (timeout as { status?: number }).status;
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

  const first = provider([timeout, GOOD]);
  assert.equal((await first.llm.complete(REQUEST)).usage?.attempts, 2);

  const second = provider([dropped, dropped, dropped], { LLM_MAX_RETRIES: '2' });
  assert.equal((await failureOf(second.llm.complete(REQUEST))).kind, 'network');

  const third = provider([timeout, timeout, timeout]);
  assert.equal((await failureOf(third.llm.complete(REQUEST))).kind, 'timeout');
});

test('a wrong key or a rejected request is never retried', async () => {
  const auth = provider([apiError(401), GOOD]);
  const authFailure = await failureOf(auth.llm.complete(REQUEST));
  assert.equal(auth.calls.length, 1);
  assert.equal(authFailure.kind, 'auth');

  const rejected = provider([apiError(404), GOOD]);
  const rejectedFailure = await failureOf(rejected.llm.complete(REQUEST));
  assert.equal(rejected.calls.length, 1);
  assert.equal(rejectedFailure.kind, 'rejected'); // a wrong model id looks like this
});

// --- a reply that arrives with nothing usable --------------------------------

test('a refusal, a cut-off and a missing tool call are named and never retried', async () => {
  const refusal = provider([{ ...GOOD, stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] }, GOOD]);
  assert.equal((await failureOf(refusal.llm.complete(REQUEST))).kind, 'blocked');
  assert.equal(refusal.calls.length, 1);

  // Even when a tool block is present, a max_tokens stop means its argument may be incomplete.
  const cut = provider([{ ...GOOD, stop_reason: 'max_tokens' }, GOOD]);
  assert.equal((await failureOf(cut.llm.complete(REQUEST))).kind, 'truncated');
  assert.equal(cut.calls.length, 1);

  const none = provider([{ ...GOOD, stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }, GOOD]);
  const failure = await failureOf(none.llm.complete(REQUEST));
  assert.equal(failure.kind, 'no_tool_call');
  assert.equal(failure.retryable, false);
});

test('without a key the provider is unconfigured and refuses, naming nothing', async () => {
  const llm = createAnthropicProvider({ cfg: loadConfig({}).config, logger: createMemoryLogger().logger });
  assert.equal(llm.configured, false);
  const failure = await failureOf(llm.complete(REQUEST));
  assert.equal(failure.kind, 'auth');
  assert.ok(!/ANTHROPIC_API_KEY/.test(failure.message));
});

// --- the helpers -------------------------------------------------------------

test('requestedDelayMs reads retry-after-ms, retry-after seconds, an HTTP date and Gemini\'s body detail', () => {
  assert.equal(requestedDelayMs({ headers: { 'retry-after-ms': '1500' } }), 1500);
  assert.equal(requestedDelayMs({ headers: { 'retry-after': '3' } }), 3000);
  assert.equal(requestedDelayMs({ headers: new Headers({ 'retry-after': '7' }) }), 7000);
  assert.equal(requestedDelayMs({ headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:10 GMT' } }, () => Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 10_000);
  assert.equal(requestedDelayMs({ message: '{"error":{"details":[{"retryDelay":"28s"}]}}' }), 28_000);
  assert.equal(requestedDelayMs(new Error('boom')), undefined);
});

test('classifyFailure names the usual suspects', () => {
  assert.equal(classifyFailure(apiError(429)), 'rate_limit');
  assert.equal(classifyFailure(apiError(500)), 'server');
  assert.equal(classifyFailure(apiError(403)), 'auth');
  assert.equal(classifyFailure(apiError(400)), 'rejected');
  assert.equal(classifyFailure(new Error('???')), 'unknown');
});

test('withRetry hands the attempt number to the operation and honours maxRetries', async () => {
  const seen: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      seen.push(attempt);
      if (attempt < 2) throw apiError(503);
      return 'ok';
    },
    { maxRetries: 2, sleep: async () => {}, random: () => 0 },
  );
  assert.equal(result, 'ok');
  assert.deepEqual(seen, [0, 1, 2]);
});
