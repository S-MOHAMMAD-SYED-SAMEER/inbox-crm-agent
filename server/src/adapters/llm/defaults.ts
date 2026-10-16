// Provider defaults, in a module that imports nothing.
//
// `scripts/lib/stack.ts` reads these to print the temperature a run will use. It must not import an
// adapter for that: the adapters import the configuration, which would load it before the launcher
// has forced LLM_PROVIDER, and `npm run live` would silently start the mock.

/** Gemini 3's own default, kept on purpose: Google's prompting guide says to keep it for Gemini 3 models. */
export const DEFAULT_GEMINI_TEMPERATURE = 1.0;

/** Low, because this is classification and extraction, where run-to-run variation is not wanted. */
export const DEFAULT_ANTHROPIC_TEMPERATURE = 0.2;
