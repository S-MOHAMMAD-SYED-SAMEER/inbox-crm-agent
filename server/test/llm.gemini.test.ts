import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeminiProvider,
  parseGeminiResponse,
  toGeminiRequest,
  GEMINI_MIN_OUTPUT_TOKENS,
  type GeminiLike,
} from '../src/adapters/llm/gemini.ts';
import { LlmUnavailableError, type LlmRequest } from '../src/adapters/llm/types.ts';
import { UNDERSTAND_TOOL } from '../src/agent/understand/schema.ts';
import { loadConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';

// The Gemini adapter against a fake client, a fake sleep and a fake clock: no
// network, no key, no waiting. What cannot be tested this way is the wire
// contract itself, which is why the first real call is the 3b smoke test.

const REQUEST: LlmRequest = {
  purpose: 'understand',
  promptVersion: 'understand.v1',
  systemPrompt: 'You read business email.',
  messages: [{ role: 'user', content: 'SECRET-EMAIL-BODY' }],
  tool: UNDERSTAND_TOOL,
  maxTokens: 2048,
};

function reply(over: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ functionCall: { name: 'record_understanding', args: { category: 'spam' } } }] },
      },
    ],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60, thoughtsTokenCount: 140, totalTokenCount: 1100 },
    ...over,
  };
}

function apiError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status, name: 'ApiError' });
}

type Script = Array<Error | Record<string, unknown>>;

function provider(script: Script, env: Record<string, string> = {}) {
  const calls: Array<{ params: Record<string, any> }> = [];
  const client: GeminiLike = {
    models: {
      async generateContent(params) {
        calls.push({ params: params as Record<string, any> });
        const next = script.shift();
        if (next === undefined) throw new Error('the fake client ran out of scripted responses');
        if (next instanceof Error) throw next;
        return next as never;
      },
    },
  };
  const sleeps: number[] = [];
  let tick = 0;
  const logs = createMemoryLogger('llm');
  const llm = createGeminiProvider({
    client,
    cfg: loadConfig({ ...env }).config,
    retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    clock: () => (tick += 400),
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

test('the request forces the one function, sends its JSON Schema, and states temperature and the cap', () => {
  const params = toGeminiRequest(REQUEST, 'gemini-3.5-flash-lite', 1.0, 30_000) as Record<string, any>;
  assert.equal(params.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(params.contents, [{ role: 'user', parts: [{ text: 'SECRET-EMAIL-BODY' }] }]);
  assert.equal(params.config.systemInstruction, 'You read business email.');
  assert.equal(params.config.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.deepEqual(params.config.toolConfig.functionCallingConfig.allowedFunctionNames, ['record_understanding']);
  const declaration = params.config.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'record_understanding');
  assert.equal(declaration.parametersJsonSchema, UNDERSTAND_TOOL.inputSchema);
  assert.equal(params.config.temperature, 1.0);
  assert.ok(params.config.abortSignal instanceof AbortSignal, 'no per-attempt timeout');
});

test('the output cap is never below the floor that leaves room for reasoning', () => {
  const cap = (maxTokens: number | undefined) =>
    (toGeminiRequest({ ...REQUEST, maxTokens }, 'm', 1, 1000) as Record<string, any>).config.maxOutputTokens;
  assert.equal(cap(1024), GEMINI_MIN_OUTPUT_TOKENS);
  assert.equal(cap(undefined), GEMINI_MIN_OUTPUT_TOKENS);
  assert.equal(cap(8000), 8000);
});

test('an assistant turn is sent with the role "model"', () => {
  const params = toGeminiRequest(
    { ...REQUEST, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
    'm',
    1,
    1000,
  ) as Record<string, any>;
  assert.deepEqual(params.contents.map((c: { role: string }) => c.role), ['user', 'model']);
});

test('the default model is gemini-3.5-flash-lite, the default temperature 1.0, and LLM_TEMPERATURE overrides it', async () => {
  const a = provider([reply()]);
  await a.llm.complete(REQUEST);
  assert.equal(a.calls[0]!.params.model, 'gemini-3.5-flash-lite');
  assert.equal(a.calls[0]!.params.config.temperature, 1.0);

  const b = provider([reply()], { LLM_TEMPERATURE: '0.4', GEMINI_MODEL: 'gemini-test' });
  await b.llm.complete(REQUEST);
  assert.equal(b.calls[0]!.params.model, 'gemini-test');
  assert.equal(b.calls[0]!.params.config.temperature, 0.4);
});

// --- what is recorded --------------------------------------------------------

test('a successful call records tokens (thinking apart), latency, attempts, finish reason, temperature and cap', async () => {
  const { llm, logs } = provider([reply()]);
  const response = await llm.complete(REQUEST);

  assert.deepEqual(response.toolInput, { category: 'spam' });
  assert.deepEqual(response.usage, {
    model: 'gemini-3.5-flash-lite',
    inputTokens: 900,
    outputTokens: 60,
    thinkingTokens: 140,
    totalTokens: 1100,
    latencyMs: 400,
    attempts: 1,
    finishReason: 'STOP',
    temperature: 1.0,
    maxTokens: GEMINI_MIN_OUTPUT_TOKENS,
  });
  assert.ok(!JSON.stringify(logs.entries).includes('SECRET-EMAIL-BODY'));
  assert.ok(logs.entries.some((e) => e.message.includes('thinkingTokens=140')));
});

// --- failures ----------------------------------------------------------------

test('a 429 with a short retryDelay is retried after exactly that wait; a long one is not retried', async () => {
  const short = provider([apiError(429, '{"error":{"details":[{"retryDelay":"4s"}]}}'), reply()]);
  const response = await short.llm.complete(REQUEST);
  assert.deepEqual(short.sleeps, [4000]);
  assert.equal(response.usage?.attempts, 2);

  const long = provider([apiError(429, '{"error":{"details":[{"retryDelay":"51s"}]}}'), reply()]);
  const failure = await failureOf(long.llm.complete(REQUEST));
  assert.equal(long.calls.length, 1, 'it waited out a free-tier quota instead of failing fast');
  assert.equal(failure.kind, 'rate_limit');
  assert.equal(failure.retryAfterMs, 51_000);
});

test('a 5xx is retried up to the limit and then named', async () => {
  const { llm, calls } = provider([apiError(503), apiError(503), apiError(503), reply()], { LLM_MAX_RETRIES: '2' });
  const failure = await failureOf(llm.complete(REQUEST));
  assert.equal(calls.length, 3);
  assert.equal(failure.kind, 'server');
});

test('a timeout (the abort signal firing) is retried and named', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { llm, calls } = provider([timeout, timeout, timeout]);
  assert.equal((await failureOf(llm.complete(REQUEST))).kind, 'timeout');
  assert.equal(calls.length, 3);
});

test('a wrong key, a wrong model id and a rejected request are never retried', async () => {
  for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [404, 'rejected'], [400, 'rejected']] as const) {
    const { llm, calls } = provider([apiError(status), reply()]);
    assert.equal((await failureOf(llm.complete(REQUEST))).kind, kind);
    assert.equal(calls.length, 1, `HTTP ${status} was retried`);
  }
});

test('a blocked prompt, a safety stop, a cut-off and a missing call are named and not retried', async () => {
  const blockedPrompt = provider([reply({ candidates: undefined, promptFeedback: { blockReason: 'SAFETY' } }), reply()]);
  assert.equal((await failureOf(blockedPrompt.llm.complete(REQUEST))).kind, 'blocked');
  assert.equal(blockedPrompt.calls.length, 1);

  const safety = provider([reply({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), reply()]);
  assert.equal((await failureOf(safety.llm.complete(REQUEST))).kind, 'blocked');
  assert.equal(safety.calls.length, 1);

  const cut = provider([
    reply({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ functionCall: { name: 'record_understanding', args: {} } }] } }] }),
    reply(),
  ]);
  assert.equal((await failureOf(cut.llm.complete(REQUEST))).kind, 'truncated');
  assert.equal(cut.calls.length, 1);

  const text = provider([reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }] }), reply()]);
  const failure = await failureOf(text.llm.complete(REQUEST));
  assert.equal(failure.kind, 'no_tool_call');
  assert.equal(failure.retryable, false);
});

test('a reply with no candidates at all is a flaky empty turn and is retried', async () => {
  const { llm, calls } = provider([reply({ candidates: [] }), reply()]);
  const response = await llm.complete(REQUEST);
  assert.equal(calls.length, 2);
  assert.equal(response.usage?.attempts, 2);
});

test('parseGeminiResponse refuses a non-object argument', () => {
  assert.throws(
    () =>
      parseGeminiResponse(
        reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'record_understanding', args: 'x' } }] } }] }) as never,
        'record_understanding',
      ),
    (err: unknown) => err instanceof LlmUnavailableError && err.kind === 'no_tool_call',
  );
});

test('without a key the provider is unconfigured and refuses, naming nothing', async () => {
  const llm = createGeminiProvider({ cfg: loadConfig({}).config, logger: createMemoryLogger().logger });
  assert.equal(llm.configured, false);
  const failure = await failureOf(llm.complete(REQUEST));
  assert.equal(failure.kind, 'auth');
  assert.ok(!/GEMINI_API_KEY/.test(failure.message));
});
