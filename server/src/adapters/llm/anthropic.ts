import Anthropic from '@anthropic-ai/sdk';
import {
  LlmUnavailableError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from './types.ts';
import { config, type AppConfig } from '../../config/env.ts';
import { classifyFailure, isRetryable, requestedDelayMs, statusOf, withRetry, type RetryOptions } from './resilience.ts';
import { formatUsage } from './usage.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';

// The Anthropic provider.
//
// STATUS: implemented and unit-tested against a stub client; **never run against
// the real API** (no key, no credits). What is unverified is the wire contract.
//
// FORCED TOOL CALL. `tool_choice` names the tool, so the model's only valid
// response is a call to it. This is the difference between "please reply in
// JSON" and a shape the provider itself enforces — it removes the entire class
// of failure where the answer arrives wrapped in prose or a markdown fence.
//
// NO SILENT FALLBACK. Every failure — missing key, network, rate limit, refusal,
// a cut-off reply, a response with no tool call in it — raises
// `LlmUnavailableError`, with a `kind` that says which. Nothing here ever returns a
// fabricated result or quietly hands off to the mock. A run that believed it called
// Claude but actually replayed a fixture would invalidate every number taken from it.
//
// LIMITS, ALL EXPLICIT. A timeout per attempt; the SDK's own retries are switched
// off and replaced by `withRetry`, which retries a 429, a 5xx, a timeout or a
// dropped connection with backoff, waits the server's `Retry-After` when it gives
// one, and does not retry at all when that wait is over 15 s. Temperature and the
// output-token cap are sent on every call and recorded with the tokens and latency.
//
// TESTABILITY WITHOUT CREDENTIALS. The client is injectable, and so are the sleep
// and the clock. Request-shaping and response-parsing are exported and pure.

type MessageCreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Messages.Message;

/** The minimum surface this adapter uses — what a test stub has to provide. */
export type AnthropicLike = {
  messages: {
    create(params: MessageCreateParams, options?: { timeout?: number; maxRetries?: number }): Promise<Message>;
  };
};

/** Low, because this is classification and extraction, where run-to-run variation is not wanted. */
export const DEFAULT_ANTHROPIC_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 2048;

export function toAnthropicRequest(
  request: LlmRequest,
  model: string,
  temperature: number = DEFAULT_ANTHROPIC_TEMPERATURE,
): MessageCreateParams {
  return {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature,
    system: request.systemPrompt,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tools: [
      {
        name: request.tool.name,
        description: request.tool.description,
        input_schema: request.tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
      },
    ],
    // The whole point: not "you may call this tool" but "this is your response".
    tool_choice: { type: 'tool', name: request.tool.name },
  };
}

export function parseAnthropicResponse(response: Message, toolName: string): Record<string, unknown> {
  const stopReason = response.stop_reason ?? 'unknown';

  if (stopReason === 'refusal') {
    // The model declined. Asking again repeats the refusal.
    throw new LlmUnavailableError('anthropic', `The model declined to answer (stop reason: ${stopReason}).`, {
      kind: 'blocked',
    });
  }

  if (stopReason === 'max_tokens') {
    // Cut off before it finished the call: the tool argument may be incomplete, so it is not parsed.
    throw new LlmUnavailableError(
      'anthropic',
      `The reply hit the output-token limit before the tool call finished (stop reason: ${stopReason}).`,
      { kind: 'truncated' },
    );
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use' && block.name === toolName,
  );

  if (!toolUse) {
    // A response with no tool call is not something to salvage: there is no
    // structured answer, which the caller must see as a failure rather than as
    // an empty reading.
    throw new LlmUnavailableError('anthropic', `The model did not call ${toolName} (stop reason: ${stopReason}).`, {
      kind: 'no_tool_call',
    });
  }

  if (typeof toolUse.input !== 'object' || toolUse.input === null || Array.isArray(toolUse.input)) {
    throw new LlmUnavailableError('anthropic', `${toolName} was called with a non-object argument.`, {
      kind: 'no_tool_call',
    });
  }

  return toolUse.input as Record<string, unknown>;
}

export type AnthropicProviderOptions = {
  client?: AnthropicLike;
  model?: string;
  cfg?: AppConfig;
  /** Overrides for tests: a fake sleep so retries do not wait, a fake clock, a fixed random source. */
  retry?: Pick<RetryOptions, 'sleep' | 'random' | 'now'>;
  clock?: () => number;
  logger?: Logger;
};

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LlmProvider {
  const cfg = options.cfg ?? config;
  const model = options.model ?? cfg.anthropicModel;
  const temperature = cfg.llmTemperature ?? DEFAULT_ANTHROPIC_TEMPERATURE;
  const clock = options.clock ?? (() => performance.now());
  const logger = options.logger ?? createLogger('llm');

  const client =
    options.client ??
    (cfg.anthropicApiKey !== null
      ? (new Anthropic({ apiKey: cfg.anthropicApiKey, maxRetries: 0 }) as AnthropicLike)
      : null);

  return {
    name: 'anthropic',
    configured: client !== null,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      if (!client) {
        // Says what is missing without naming it — the operator-facing detail
        // (which variable) is already logged at startup by config/env.ts.
        throw new LlmUnavailableError('anthropic', 'The Anthropic provider is selected but not configured.', {
          kind: 'auth',
        });
      }

      const params = toAnthropicRequest(request, model, temperature);
      const startedAt = clock();
      let attempts = 0;

      let response: Message;
      try {
        response = await withRetry(
          async () => {
            attempts += 1;
            return client.messages.create(params, { timeout: cfg.llmTimeoutMs, maxRetries: 0 });
          },
          {
            maxRetries: cfg.llmMaxRetries,
            ...options.retry,
            onRetry: ({ attempt, delayMs, error }) =>
              logger.warn(
                `Anthropic call failed (${classifyFailure(error)}, status ${statusOf(error) ?? 'none'}); retry ${attempt} in ${Math.round(delayMs)} ms.`,
              ),
          },
        );
      } catch (err) {
        const kind = classifyFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        throw new LlmUnavailableError('anthropic', `The analysis provider could not be reached: ${message}`, {
          cause: err,
          kind,
          retryable: isRetryable(err),
          status: statusOf(err),
          retryAfterMs: requestedDelayMs(err),
        });
      }

      const toolInput = parseAnthropicResponse(response, request.tool.name);
      const latencyMs = clock() - startedAt;
      const inputTokens = response.usage?.input_tokens ?? null;
      const outputTokens = response.usage?.output_tokens ?? null;
      const usage: LlmUsage = {
        model: response.model ?? model,
        inputTokens,
        outputTokens,
        thinkingTokens: null,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        latencyMs,
        attempts,
        finishReason: response.stop_reason ?? null,
        temperature,
        maxTokens: params.max_tokens,
      };
      logger.info(`call ${formatUsage(usage, request.purpose)}`);

      return {
        toolInput,
        model: usage.model,
        latencyMs,
        stopReason: response.stop_reason ?? 'tool_use',
        usage,
      };
    },
  };
}
