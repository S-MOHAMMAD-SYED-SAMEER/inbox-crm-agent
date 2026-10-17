import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from '../../adapters/llm/index.ts';
import type { RecordedCall } from './runner.ts';

// A provider that answers from the raw replies a real run SAVED, so the pipeline, the scoring and
// the guardrails can be re-run offline, with no key, no network and no model request.
//
// This is how a fix to the code around the model is measured against the answers the model
// actually gave: same replies, new code. It cannot say what the model would answer to a changed
// prompt; that needs a real request.
//
// Replies are served per email and purpose, in the order they were recorded (a repair retry is a
// second reply for the same email). A recorded failure is thrown again, so a run with a failed
// request replays as the same failure. Asking for something that was never recorded throws
// rather than inventing an answer.

export type ReplayOptions = {
  /**
   * Replies to use where the saved run had a failed request (for example a draft that got a 503
   * and was asked again later), keyed like a recorded call: `${fixtureId}|${purpose}`.
   */
  fill?: ReadonlyMap<string, LlmResponse>;
};

export function replayKey(fixtureId: string | undefined, purpose: string): string {
  return `${fixtureId ?? ''}|${purpose}`;
}

export function createReplayProvider(calls: readonly RecordedCall[], options: ReplayOptions = {}): LlmProvider {
  const queues = new Map<string, RecordedCall[]>();
  for (const call of calls) {
    const key = replayKey(call.fixtureId, call.purpose);
    queues.set(key, [...(queues.get(key) ?? []), call]);
  }

  return {
    name: 'gemini',
    configured: true,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const key = replayKey(request.metadata?.fixtureId, request.purpose);
      const recorded = queues.get(key)?.shift();
      if (recorded?.ok && recorded.response) return structuredClone(recorded.response);
      const filled = options.fill?.get(key);
      if (filled) return structuredClone(filled);
      if (recorded?.error) {
        throw new LlmUnavailableError('gemini', recorded.error.message, {
          kind: recorded.error.kind as never,
          ...(recorded.error.status !== undefined ? { status: recorded.error.status } : {}),
        });
      }
      throw new Error(`replay: no saved reply for ${key}`);
    },
  };
}
