import { LlmUnavailableError, type LlmFailureKind } from './types.ts';

// Shared failure handling for the model adapters: which errors are worth a
// retry, how long to wait, and how a failure is named. Pure functions with an
// injectable clock, sleep and random source, so the behaviour is tested with fake
// clients and no real waiting.
//
// THE RULE ON WAITING. If the server asks for a wait longer than `maxDelayMs`
// (15 s by default) the call is not retried: it fails at once. Someone waiting on
// a reply is better told "try again" now than held for a minute, and a per-day
// quota does not clear by waiting.

export const MAX_RETRY_WAIT_MS = 15_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type ErrorLike = {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  headers?: unknown;
  cause?: { code?: unknown } | null;
};

function asErrorLike(err: unknown): ErrorLike {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : {};
}

/** The HTTP status carried by an SDK error, when it has one. */
export function statusOf(err: unknown): number | undefined {
  const status = asErrorLike(err).status;
  return typeof status === 'number' ? status : undefined;
}

export function isTimeout(err: unknown): boolean {
  const { name, code } = asErrorLike(err);
  return name === 'TimeoutError' || name === 'AbortError' || name === 'APIConnectionTimeoutError' || code === 'ETIMEDOUT';
}

function isConnectionFailure(err: unknown): boolean {
  const e = asErrorLike(err);
  if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
  if (typeof e.cause?.code === 'string' && RETRYABLE_CODES.has(e.cause.code)) return true;
  // undici reports a dropped connection as "TypeError: fetch failed"; the Anthropic SDK as APIConnectionError.
  return (
    e.name === 'APIConnectionError' ||
    (err instanceof TypeError && /fetch failed/i.test(String(e.message ?? '')))
  );
}

/** Names a failure so that callers (and the audit log) can tell a rate limit from an outage. */
export function classifyFailure(err: unknown): LlmFailureKind {
  if (err instanceof LlmUnavailableError) return err.kind;
  const status = statusOf(err);
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'rejected';
  if (status !== undefined && status >= 500) return 'server';
  if (isTimeout(err)) return 'timeout';
  if (isConnectionFailure(err)) return 'network';
  return 'unknown';
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmUnavailableError) return err.retryable;
  const status = statusOf(err);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  return isTimeout(err) || isConnectionFailure(err);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value ?? undefined;
  }
  const bag = headers as Record<string, unknown>;
  const value = bag[name] ?? bag[name.toLowerCase()];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * How long the server asked us to wait, in ms, or undefined if it did not say:
 * `retry-after-ms`, then `retry-after` (seconds or an HTTP date) from the SDK's
 * headers, then the `retryDelay: "28s"` detail Gemini puts in a 429 body, which
 * its SDK surfaces inside the error message.
 */
export function requestedDelayMs(err: unknown, now: () => number = Date.now): number | undefined {
  const headers = asErrorLike(err).headers;

  const ms = Number(readHeader(headers, 'retry-after-ms'));
  if (readHeader(headers, 'retry-after-ms') !== undefined && Number.isFinite(ms) && ms >= 0) return ms;

  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now());
  }

  const fromBody = /retry(?:Delay)?"?\s*(?::|in)\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(asErrorLike(err).message ?? ''));
  if (fromBody) return Number(fromBody[1]) * 1000;

  return undefined;
}

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

/**
 * Runs `operation` and retries it on a retryable failure, at most `maxRetries`
 * more times. The wait is whatever the server asked for, otherwise exponential
 * backoff with jitter. A requested wait over `maxDelayMs` is not waited out.
 * `operation` receives the attempt number (0 for the first try).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  {
    maxRetries = 2,
    baseDelayMs = 500,
    maxDelayMs = MAX_RETRY_WAIT_MS,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
    onRetry = () => {},
  }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;

      const requested = requestedDelayMs(err, now);
      if (requested !== undefined && requested > maxDelayMs) throw err;

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + random() * baseDelayMs);
      const delayMs = requested !== undefined ? requested : backoff;
      onRetry({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
