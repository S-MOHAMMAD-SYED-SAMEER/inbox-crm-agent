import fs from 'node:fs';
import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from '../adapters/llm/types.ts';

// The recorded model run the guest demo replays.
//
// A guest never reaches a model. The model call, and only the model call, is replaced by an answer that a real run gave, played
// back unchanged. Everything around it (the verbatim field check, the follow-up context check, the injection detector, the rules,
// the draft checks, the approval policy) runs live on each replayed answer, exactly as it did on the real one.
//
// KEYED BY EMAIL, STEP AND PROMPT VERSION
//
// An answer was given to one prompt. If the prompt changes, the answer was given to a different question, and replaying it would be
// showing a guest something this code did not ask. So the key includes the prompt version the request carries, and a request for a
// version that was not recorded fails with "no recorded answer for this step": it does not fall back to an old answer, and it never
// makes one up.

export type RecordedReply = {
  fixtureId: string;
  purpose: string;
  promptVersion: string;
  toolInput: Record<string, unknown>;
  latencyMs: number;
  stopReason: string;
};

export type RecordingProvenance = {
  provider: string;
  model: string;
  temperature: number;
  recordedAt: string;
  run: string;
  sourceReport: string;
  promptVersions: Record<string, string>;
  note: string;
};

export type Recording = {
  kind: 'recorded-model-run';
  provenance: RecordingProvenance;
  replies: RecordedReply[];
};

export const NO_RECORDED_ANSWER = 'No recorded answer for this step.';

export function replyKey(fixtureId: string | undefined, purpose: string, promptVersion: string): string {
  return `${fixtureId ?? ''}|${purpose}|${promptVersion}`;
}

export function parseRecording(raw: unknown): Recording {
  const record = raw as Partial<Recording> | null;
  if (!record || record.kind !== 'recorded-model-run' || !record.provenance || !Array.isArray(record.replies)) {
    throw new Error('The replay recording is not a recorded model run.');
  }
  const seen = new Set<string>();
  for (const reply of record.replies) {
    if (typeof reply.fixtureId !== 'string' || typeof reply.purpose !== 'string' || typeof reply.promptVersion !== 'string') {
      throw new Error('A recorded reply has no email, step and prompt version.');
    }
    if (!reply.toolInput || typeof reply.toolInput !== 'object') throw new Error(`The recorded reply for ${reply.fixtureId} has no answer.`);
    const key = replyKey(reply.fixtureId, reply.purpose, reply.promptVersion);
    if (seen.has(key)) throw new Error(`Two recorded replies share ${key}.`);
    seen.add(key);
  }
  const provenance = record.provenance;
  for (const field of ['provider', 'model', 'recordedAt', 'run', 'sourceReport'] as const) {
    if (typeof provenance[field] !== 'string' || provenance[field] === '') throw new Error(`The recording has no ${field}.`);
  }
  if (typeof provenance.temperature !== 'number') throw new Error('The recording has no temperature.');
  return record as Recording;
}

export function loadRecording(filePath: string): Recording {
  return parseRecording(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/** The name shown wherever the pipeline records which model answered. It says the answer was recorded. */
export function recordedModelLabel(recording: Recording): string {
  return `${recording.provenance.model} (recorded)`;
}

export type RecordedProvider = LlmProvider & {
  /** How many times the provider was asked. A guest session is allowed any number; none of them leaves the process. */
  readonly asked: number;
};

/**
 * The provider a guest session uses. It makes no network call and holds no key: it looks the request up in the recording.
 *
 * The same answer is served every time it is asked for, so "Analyse again" replays the same recorded answer rather than failing
 * or varying.
 */
export function createRecordedProvider(recording: Recording): RecordedProvider {
  const replies = new Map(recording.replies.map((reply) => [replyKey(reply.fixtureId, reply.purpose, reply.promptVersion), reply]));
  const model = recordedModelLabel(recording);
  let asked = 0;

  return {
    name: 'replay',
    configured: true,
    get asked() {
      return asked;
    },
    async complete(request: LlmRequest): Promise<LlmResponse> {
      asked += 1;
      const reply = replies.get(replyKey(request.metadata?.fixtureId, request.purpose, request.promptVersion));
      if (!reply) {
        throw new LlmUnavailableError('replay', NO_RECORDED_ANSWER, { kind: 'rejected', retryable: false });
      }
      return {
        toolInput: structuredClone(reply.toolInput),
        model,
        latencyMs: reply.latencyMs,
        stopReason: reply.stopReason,
      };
    },
  };
}
