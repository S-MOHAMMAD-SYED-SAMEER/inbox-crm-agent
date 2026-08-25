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

export type LlmResponse = {
  /** The tool's argument object — the structured output, unparsed and unvalidated. */
  toolInput: Record<string, unknown>;
  model: string;
  latencyMs: number;
  stopReason: string;
};

export type LlmProvider = {
  readonly name: LlmProviderName;
  /** False when the provider needs a key it does not have. Never exposes the key itself. */
  readonly configured: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
};

/** Thrown when a provider cannot produce a response at all (network, auth, quota). */
export class LlmUnavailableError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'LlmUnavailableError';
    this.provider = provider;
  }
}
