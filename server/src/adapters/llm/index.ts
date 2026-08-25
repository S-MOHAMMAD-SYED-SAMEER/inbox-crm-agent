import { config, type AppConfig } from '../../config/env.ts';
import { createMockLlmProvider } from './mock.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { LlmUnavailableError, type LlmProvider } from './types.ts';

export type { LlmProvider, LlmRequest, LlmResponse, LlmToolSchema, LlmMessage } from './types.ts';
export { LlmUnavailableError } from './types.ts';
export { createMockLlmProvider, MockResponseNotFoundError, type MockLlmProvider } from './mock.ts';
export { registerDemoFixtures, readMockUnderstandings } from './fixtures.ts';
export {
  createAnthropicProvider,
  toAnthropicRequest,
  parseAnthropicResponse,
  type AnthropicLike,
} from './anthropic.ts';

/**
 * Selects the provider for the current configuration.
 *
 * `mock` remains the default (D3): the whole demo runs offline, deterministically
 * and for ₹0. `anthropic` is implemented as of M1 and is used only when
 * explicitly selected *and* configured.
 *
 * There is no fallback path. Selecting a provider that cannot run raises
 * instead of quietly substituting another one — a run that believed it called
 * Claude and actually replayed a fixture would invalidate any result taken from
 * it, so that outcome is designed out rather than guarded against.
 */
export function createLlmProvider(cfg: AppConfig = config): LlmProvider {
  switch (cfg.llmProvider) {
    case 'mock':
      return createMockLlmProvider();

    case 'anthropic': {
      const provider = createAnthropicProvider({ cfg });
      if (!provider.configured) {
        throw new LlmUnavailableError(
          'anthropic',
          'LLM_PROVIDER is "anthropic" but no API key is configured. Set ANTHROPIC_API_KEY, or use LLM_PROVIDER=mock.',
        );
      }
      return provider;
    }

    case 'gemini':
      throw new LlmUnavailableError(
        'gemini',
        'The Gemini provider is not implemented for this project. Use "mock" or "anthropic".',
      );

    default: {
      const exhaustive: never = cfg.llmProvider;
      throw new LlmUnavailableError(String(exhaustive), 'Unknown LLM provider.');
    }
  }
}
