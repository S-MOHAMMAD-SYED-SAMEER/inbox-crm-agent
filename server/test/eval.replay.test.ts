import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmUnavailableError } from '../src/adapters/llm/index.ts';
import type { LlmRequest, LlmResponse } from '../src/adapters/llm/index.ts';
import { createReplayProvider, replayKey } from '../src/eval/real/replay.ts';
import type { RecordedCall } from '../src/eval/real/runner.ts';

// The replay provider answers from saved raw replies: no key, no network. These tests pin the
// rules that keep an offline re-score honest.

const reply = (text: string): LlmResponse => ({ toolInput: { text }, model: 'm', latencyMs: 1, stopReason: 'tool_use' }) as LlmResponse;
const call = (n: number, fixtureId: string, purpose: string, response?: LlmResponse, error?: RecordedCall['error']): RecordedCall => ({
  n,
  purpose,
  promptVersion: 'v',
  fixtureId,
  ok: response !== undefined,
  ...(response ? { response } : {}),
  ...(error ? { error } : {}),
});
const ask = (fixtureId: string, purpose: string): LlmRequest => ({ purpose, metadata: { fixtureId } }) as unknown as LlmRequest;

test('replies are served per email and purpose, in the order they were recorded (a repair retry is a second reply)', async () => {
  const provider = createReplayProvider([
    call(1, 'a', 'understand', reply('a1')),
    call(2, 'b', 'understand', reply('b1')),
    call(3, 'a', 'understand', reply('a2')),
  ]);
  assert.deepEqual((await provider.complete(ask('a', 'understand'))).toolInput, { text: 'a1' });
  assert.deepEqual((await provider.complete(ask('b', 'understand'))).toolInput, { text: 'b1' });
  assert.deepEqual((await provider.complete(ask('a', 'understand'))).toolInput, { text: 'a2' });
});

test('a saved failure is thrown again, with its kind and status', async () => {
  const provider = createReplayProvider([call(1, 'a', 'draft', undefined, { kind: 'server', message: 'HTTP 503', status: 503, retryAfterMs: undefined })]);
  await assert.rejects(
    () => provider.complete(ask('a', 'draft')),
    (err: unknown) => err instanceof LlmUnavailableError && err.kind === 'server' && err.status === 503,
  );
});

test('a reply supplied for a failed request is used, and only where the saved run had no reply', async () => {
  const fill = new Map([[replayKey('a', 'draft'), reply('filled')]]);
  const failed = createReplayProvider([call(1, 'a', 'draft', undefined, { kind: 'server', message: 'x', status: 503, retryAfterMs: undefined })], { fill });
  assert.deepEqual((await failed.complete(ask('a', 'draft'))).toolInput, { text: 'filled' });
  const answered = createReplayProvider([call(1, 'a', 'draft', reply('saved'))], { fill });
  assert.deepEqual((await answered.complete(ask('a', 'draft'))).toolInput, { text: 'saved' });
});

test('asking for something never recorded throws instead of inventing an answer', async () => {
  const provider = createReplayProvider([call(1, 'a', 'understand', reply('x'))]);
  await assert.rejects(() => provider.complete(ask('zzz', 'understand')), /no saved reply/);
  await provider.complete(ask('a', 'understand'));
  await assert.rejects(() => provider.complete(ask('a', 'understand')), /no saved reply/);
});

test('a served reply is a copy: changing it does not change what is replayed next time', async () => {
  const saved = reply('x');
  const one = createReplayProvider([call(1, 'a', 'understand', saved)]);
  const got = await one.complete(ask('a', 'understand'));
  (got.toolInput as { text: string }).text = 'mutated';
  assert.deepEqual((saved.toolInput as { text: string }).text, 'x');
});
