import type { LlmUsage } from './types.ts';

// Token and latency accounting for model calls. Each real provider reports one
// `LlmUsage` per call; a run (the live demo, an evaluation) sums them. Tokens, not
// money: a price per token is not something this code can know, and a price
// written here from memory would be exactly the unverified claim this project
// avoids.

function sum(records: readonly LlmUsage[], field: 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'totalTokens'): number | null {
  const values = records.map((r) => r[field]).filter((v): v is number => typeof v === 'number');
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

export type UsageSummary = {
  calls: number;
  /** Provider requests including retries (a 429 that was retried counts twice). */
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
};

/** Totals over a list of per-call records; null when there were no model calls (the mock makes none). */
export function summarizeUsage(records: readonly (LlmUsage | undefined)[]): UsageSummary | null {
  const list = records.filter((r): r is LlmUsage => r !== undefined);
  if (list.length === 0) return null;
  return {
    calls: list.length,
    requests: list.reduce((total, r) => total + r.attempts, 0),
    inputTokens: sum(list, 'inputTokens'),
    outputTokens: sum(list, 'outputTokens'),
    thinkingTokens: sum(list, 'thinkingTokens'),
    totalTokens: sum(list, 'totalTokens'),
    latencyMs: list.reduce((total, r) => total + r.latencyMs, 0),
  };
}

/** One log line. Numbers and names only: never the prompt, the reply or a key. */
export function formatUsage(usage: LlmUsage, purpose?: string): string {
  const part = (label: string, value: number | string | null | undefined): string | null =>
    value === null || value === undefined ? null : `${label}=${value}`;
  return [
    part('purpose', purpose),
    part('model', usage.model),
    part('temperature', usage.temperature),
    part('maxTokens', usage.maxTokens),
    part('inputTokens', usage.inputTokens),
    part('outputTokens', usage.outputTokens),
    part('thinkingTokens', usage.thinkingTokens),
    part('totalTokens', usage.totalTokens),
    part('latencyMs', Math.round(usage.latencyMs)),
    part('attempts', usage.attempts),
    part('finishReason', usage.finishReason),
  ]
    .filter((p): p is string => p !== null)
    .join(' ');
}
