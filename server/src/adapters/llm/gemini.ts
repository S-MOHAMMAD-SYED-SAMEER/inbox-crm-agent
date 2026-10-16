import { GoogleGenAI } from '@google/genai';
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
import { DEFAULT_GEMINI_TEMPERATURE } from './defaults.ts';

// The Gemini provider.
//
// STATUS: implemented and unit-tested against a fake client; **never run against
// the real API** (no call has been made). The first real request is the 3b smoke
// test. Three things below are assumptions that smoke test must confirm; they are
// marked UNVERIFIED.
//
// FORCED FUNCTION CALL. `toolConfig.functionCallingConfig` has mode ANY and names the
// one allowed function, so the model's only valid response is a call to it: the same
// guarantee the Anthropic adapter gets from `tool_choice`. The tool's JSON Schema is
// sent as `parametersJsonSchema`. UNVERIFIED: that Gemini accepts the schema as written
// (it uses `type: ['string', 'null']` unions and `additionalProperties: false`).
//
// NO SILENT FALLBACK. Every failure raises `LlmUnavailableError` with a `kind`; nothing
// returns a fabricated result or hands off to the mock.
//
// LIMITS, EXPLICIT AND RECORDED. A timeout per attempt (an abort signal); `withRetry` on a
// 429, a 5xx, a timeout or a dropped connection, waiting the server's Retry-After (Gemini
// puts it in the 429 body as `retryDelay`), and never retrying a wait over 15 s (a spent
// free-tier quota). Temperature defaults to 1.0, which Google's prompting guide says to keep
// for Gemini 3 models; LLM_TEMPERATURE overrides it. UNVERIFIED: that 1.0 is right for
// extraction; the smoke test records what the model does.
//
// OUTPUT CAP INCLUDES REASONING. A Gemini 3 model spends output tokens on thinking before it
// answers, and `maxOutputTokens` covers both, so a cap sized for the visible reply alone can be
// eaten by the reasoning and the call comes back cut off (MAX_TOKENS) with no function call.
// The cap sent is therefore never below `GEMINI_MIN_OUTPUT_TOKENS`, and the value actually
// sent is recorded with every call. UNVERIFIED: that 4096 is enough; the smoke test shows the
// thinking tokens used.

type GenerateParams = Parameters<GoogleGenAI['models']['generateContent']>[0];
type GenerateResponse = Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;

/** The minimum surface this adapter uses — what a test fake has to provide. */
export type GeminiLike = {
  models: { generateContent(params: GenerateParams): Promise<GenerateResponse> };
};

export { DEFAULT_GEMINI_TEMPERATURE };
export const GEMINI_MIN_OUTPUT_TOKENS = 4096;

/** Finish reasons meaning the content itself was refused. Asking again gets the same answer. */
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
]);

export function toGeminiRequest(
  request: LlmRequest,
  model: string,
  temperature: number,
  timeoutMs: number,
  signal?: AbortSignal,
): GenerateParams {
  return {
    model,
    // Gemini uses the role "model" for assistant turns, not "assistant".
    contents: request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    config: {
      systemInstruction: request.systemPrompt,
      tools: [
        {
          functionDeclarations: [
            {
              name: request.tool.name,
              description: request.tool.description,
              parametersJsonSchema: request.tool.inputSchema,
            },
          ],
        },
      ],
      // The whole point: not "you may call this function" but "this is your response".
      toolConfig: { functionCallingConfig: { mode: 'ANY' as never, allowedFunctionNames: [request.tool.name] } },
      maxOutputTokens: Math.max(request.maxTokens ?? 0, GEMINI_MIN_OUTPUT_TOKENS),
      temperature,
      // Per attempt: a hung request is cut off, then retried or failed.
      abortSignal: signal ?? AbortSignal.timeout(timeoutMs),
    },
  };
}

export function parseGeminiResponse(response: GenerateResponse, toolName: string): Record<string, unknown> {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmUnavailableError('gemini', `Gemini blocked the prompt (${String(blockReason)}).`, { kind: 'blocked' });
  }

  const candidate = response.candidates?.[0];
  if (!response.candidates || response.candidates.length === 0 || !candidate) {
    // No candidates at all is a flaky empty turn that a second attempt can reasonably fix.
    throw new LlmUnavailableError('gemini', 'Gemini returned no candidates.', { kind: 'no_tool_call', retryable: true });
  }

  const finishReason = candidate.finishReason ? String(candidate.finishReason) : undefined;
  const parts = candidate.content?.parts ?? [];
  const call = parts.find((part) => part.functionCall?.name === toolName)?.functionCall;

  if (finishReason === 'MAX_TOKENS') {
    // Cut off, often by reasoning using the whole cap: the argument may be incomplete, so it is not parsed.
    throw new LlmUnavailableError(
      'gemini',
      `The reply hit the output-token limit before the function call finished (finish reason ${finishReason}).`,
      { kind: 'truncated' },
    );
  }

  if (!call) {
    if (finishReason !== undefined && BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new LlmUnavailableError('gemini', `Gemini returned no function call (finish reason ${finishReason}).`, {
        kind: 'blocked',
      });
    }
    throw new LlmUnavailableError('gemini', `The model did not call ${toolName} (finish reason ${finishReason ?? 'none'}).`, {
      kind: 'no_tool_call',
    });
  }

  const args = call.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new LlmUnavailableError('gemini', `${toolName} was called with a non-object argument.`, { kind: 'no_tool_call' });
  }
  return args as Record<string, unknown>;
}

export type GeminiProviderOptions = {
  client?: GeminiLike;
  model?: string;
  cfg?: AppConfig;
  retry?: Pick<RetryOptions, 'sleep' | 'random' | 'now'>;
  clock?: () => number;
  logger?: Logger;
};

export function createGeminiProvider(options: GeminiProviderOptions = {}): LlmProvider {
  const cfg = options.cfg ?? config;
  const model = options.model ?? cfg.geminiModel;
  const temperature = cfg.llmTemperature ?? DEFAULT_GEMINI_TEMPERATURE;
  const clock = options.clock ?? (() => performance.now());
  const logger = options.logger ?? createLogger('llm');

  const client =
    options.client ?? (cfg.geminiApiKey !== null ? (new GoogleGenAI({ apiKey: cfg.geminiApiKey }) as GeminiLike) : null);

  return {
    name: 'gemini',
    configured: client !== null,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      if (!client) {
        throw new LlmUnavailableError('gemini', 'The Gemini provider is selected but not configured.', { kind: 'auth' });
      }

      const startedAt = clock();
      let attempts = 0;
      let sentMaxTokens = 0;

      let response: GenerateResponse;
      let toolInput: Record<string, unknown>;
      try {
        ({ response, toolInput } = await withRetry(
          async () => {
            attempts += 1;
            const params = toGeminiRequest(request, model, temperature, cfg.llmTimeoutMs);
            sentMaxTokens = params.config?.maxOutputTokens ?? 0;
            const reply = await client.models.generateContent(params);
            // Parsed inside the retried step: a reply with no candidates is a flaky empty turn that
            // is retried like any transient failure, while a block, a cut-off or a missing call is not.
            return { response: reply, toolInput: parseGeminiResponse(reply, request.tool.name) };
          },
          {
            maxRetries: cfg.llmMaxRetries,
            ...options.retry,
            onRetry: ({ attempt, delayMs, error }) =>
              logger.warn(
                `Gemini call failed (${classifyFailure(error)}, status ${statusOf(error) ?? 'none'}); retry ${attempt} in ${Math.round(delayMs)} ms.`,
              ),
          },
        ));
      } catch (err) {
        throw toUnavailable(err);
      }

      const latencyMs = clock() - startedAt;
      const meta = response.usageMetadata;
      const finishReason = response.candidates?.[0]?.finishReason;
      const usage: LlmUsage = {
        model,
        inputTokens: meta?.promptTokenCount ?? null,
        outputTokens: meta?.candidatesTokenCount ?? null,
        thinkingTokens: meta?.thoughtsTokenCount ?? null,
        totalTokens: meta?.totalTokenCount ?? null,
        latencyMs,
        attempts,
        finishReason: finishReason ? String(finishReason) : null,
        temperature,
        maxTokens: sentMaxTokens,
      };
      logger.info(`call ${formatUsage(usage, request.purpose)}`);

      return { toolInput, model, latencyMs, stopReason: usage.finishReason ?? 'STOP', usage };
    },
  };
}

function toUnavailable(err: unknown): LlmUnavailableError {
  if (err instanceof LlmUnavailableError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LlmUnavailableError('gemini', `The analysis provider could not be reached: ${message}`, {
    cause: err,
    kind: classifyFailure(err),
    retryable: isRetryable(err),
    status: statusOf(err),
    retryAfterMs: requestedDelayMs(err),
  });
}
