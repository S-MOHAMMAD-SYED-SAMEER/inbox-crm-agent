import type { LlmProviderName } from '../../config/env.ts';

// The LLM boundary.
//
// One method, `complete()`, and it does not return prose. It returns the input
// to a **forced tool call**: the caller supplies a tool schema, the provider
// makes the model respond by calling that tool, and what comes back is the
// tool's structured argument object.
//
// WHY NOT "ask for JSON":
// A model asked to reply in JSON sometimes wraps it in prose, sometimes in a
// markdown fence, and sometimes explains itself first. Every one of those is a
// parse failure at 2am. With a tool schema the provider enforces the shape
// before we ever see it, which removes that entire class of failure rather
// than handling it. Project 1 built the same tool loop to carry side effects;
// here the identical mechanism carries structure.
//
// The hand-written validator downstream still runs, because provider-side
// schema enforcement is not a guarantee and a schema-valid response can still
// be nonsense — a confidence of 4.7, or a company name with no source span.
// Shape is the provider's job; meaning is ours.

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type LlmToolSchema = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments — this is the structure being requested. */
  inputSchema: Record<string, unknown>;
};

export type LlmRequest = {
  /** Names the call site (`understand`, `draft`). Recorded in audit payloads. */
  purpose: string;
  /** Versioned so an audit event can say which prompt produced a result. */
  promptVersion: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tool: LlmToolSchema;
  maxTokens?: number;
  /**
   * Provider-agnostic hints. The mock provider reads `fixtureId` from here to
   * select a canned response; real providers ignore it. Keeping it in a bag of
   * metadata means the shared request type has no mock-shaped field in it.
   */
  metadata?: Record<string, string>;
};

/**
 * What one model call cost, as the provider reported it. Tokens, not money: a
 * price per token is not something this code can know. Absent from the mock.
 */
export type LlmUsage = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Reasoning tokens, for providers that count them apart from the visible reply. */
  thinkingTokens: number | null;
  totalTokens: number | null;
  /** Wall-clock time for the call including any retries, so a slow retried call shows up as slow. */
  latencyMs: number;
  /** How many times the provider was asked (1, or more after a retried 429/5xx/timeout). */
  attempts: number;
  /** The provider's own stop / finish reason. */
  finishReason: string | null;
  /** The temperature that was sent. */
  temperature: number;
  /** The output-token cap that was sent. */
  maxTokens: number;
};

export type LlmResponse = {
  /** The tool's argument object — the structured output, unparsed and unvalidated. */
  toolInput: Record<string, unknown>;
  model: string;
  latencyMs: number;
  stopReason: string;
  /** Present for real providers; the mock makes no model call and has none. */
  usage?: LlmUsage;
};

export type LlmProvider = {
  readonly name: LlmProviderName;
  /** False when the provider needs a key it does not have. Never exposes the key itself. */
  readonly configured: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
};

/** Why a call produced nothing usable. Recorded in the audit log, so an outage reads differently from a refusal. */
export type LlmFailureKind =
  | 'rate_limit' // HTTP 429: too many requests, or a spent quota
  | 'timeout' // the call took longer than the configured timeout
  | 'network' // a dropped or refused connection
  | 'server' // HTTP 5xx from the provider
  | 'auth' // HTTP 401/403: a missing, wrong or unauthorised key
  | 'rejected' // HTTP 400/404/422: the request itself was refused (a wrong model id, a bad schema)
  | 'blocked' // the model declined: a safety block or a refusal; asking again repeats it
  | 'truncated' // the reply hit the output-token cap before the tool call finished
  | 'no_tool_call' // a reply arrived but did not call the tool, or its argument was not an object
  | 'unknown';

/** Thrown when a provider cannot produce a usable response at all (network, auth, quota, refusal). */
export class LlmUnavailableError extends Error {
  readonly provider: string;
  readonly kind: LlmFailureKind;
  /** Whether asking again could plausibly work. A refusal or a wrong key cannot. */
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** How long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(
    provider: string,
    message: string,
    options: {
      cause?: unknown;
      kind?: LlmFailureKind;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmUnavailableError';
    this.provider = provider;
    this.kind = options.kind ?? 'unknown';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
