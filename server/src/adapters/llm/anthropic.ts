import Anthropic from '@anthropic-ai/sdk';
import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './types.ts';
import { config, type AppConfig } from '../../config/env.ts';

// The Anthropic provider.
//
// FORCED TOOL CALL. `tool_choice` names the tool, so the model's only valid
// response is a call to it. This is the difference between "please reply in
// JSON" and a shape the provider itself enforces — it removes the entire class
// of failure where the answer arrives wrapped in prose or a markdown fence.
// Project 1 established the same tool-calling pattern; there it carried side
// effects, here it carries structure.
//
// NO SILENT FALLBACK. Every failure — missing key, network, rate limit, refusal,
// a response with no tool call in it — raises `LlmUnavailableError`. Nothing
// here ever returns a fabricated result or quietly hands off to the mock. A run
// that believed it called Claude but actually replayed a fixture would
// invalidate every number taken from it, so that possibility is designed out.
//
// TESTABILITY WITHOUT CREDENTIALS. The client is injectable. The request-shaping
// and response-parsing functions are exported and pure, so the whole adapter is
// covered by tests that use a stub client and spend nothing. What cannot be
// verified without a key is the wire contract itself — that is stated plainly
// in the README rather than implied by a passing test.

type MessageCreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Messages.Message;

/** The minimum surface this adapter uses — what a test stub has to provide. */
export type AnthropicLike = {
  messages: { create(params: MessageCreateParams): Promise<Message> };
};

export function toAnthropicRequest(request: LlmRequest, model: string): MessageCreateParams {
  return {
    model,
    max_tokens: request.maxTokens ?? 2048,
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
  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use' && block.name === toolName,
  );

  if (!toolUse) {
    // A response with no tool call is not something to salvage — a refusal, a
    // stop-sequence, or a max-tokens cut-off all land here, and all of them
    // mean "there is no structured answer", which the caller must see as a
    // failure rather than as an empty reading.
    throw new LlmUnavailableError(
      'anthropic',
      `The model did not call ${toolName} (stop reason: ${response.stop_reason ?? 'unknown'}).`,
    );
  }

  if (typeof toolUse.input !== 'object' || toolUse.input === null || Array.isArray(toolUse.input)) {
    throw new LlmUnavailableError('anthropic', `${toolName} was called with a non-object argument.`);
  }

  return toolUse.input as Record<string, unknown>;
}

export function createAnthropicProvider(
  options: { client?: AnthropicLike; model?: string; cfg?: AppConfig } = {},
): LlmProvider {
  const cfg = options.cfg ?? config;
  const model = options.model ?? cfg.anthropicModel;

  const client =
    options.client ??
    (cfg.anthropicApiKey !== null ? (new Anthropic({ apiKey: cfg.anthropicApiKey }) as AnthropicLike) : null);

  return {
    name: 'anthropic',
    configured: client !== null,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      if (!client) {
        // Says what is missing without naming it — the operator-facing detail
        // (which variable) is already logged at startup by config/env.ts.
        throw new LlmUnavailableError('anthropic', 'The Anthropic provider is selected but not configured.');
      }

      const startedAt = Date.now();
      let response: Message;
      try {
        response = await client.messages.create(toAnthropicRequest(request, model));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new LlmUnavailableError('anthropic', `The analysis provider could not be reached: ${message}`, {
          cause: err,
        });
      }

      return {
        toolInput: parseAnthropicResponse(response, request.tool.name),
        model: response.model ?? model,
        latencyMs: Date.now() - startedAt,
        stopReason: response.stop_reason ?? 'tool_use',
      };
    },
  };
}
