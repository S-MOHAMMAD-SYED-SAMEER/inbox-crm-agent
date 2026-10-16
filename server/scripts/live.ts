import { startStack } from './lib/stack.ts';

// `npm run live` (from `server/`, once the dashboard is built): the same one command as
// `npm run demo`, but against the REAL model. It sets LLM_PROVIDER=gemini (default model
// gemini-3.5-flash-lite), refuses to start, with a clear message and exit code 1, if
// GEMINI_API_KEY is not set, and prints the provider and model at start-up (never the key).
//
// Each email costs one request to read and, where a reply is warranted, one to draft; a
// reply that fails validation is asked again once. The Gemini free tier allows roughly
// 10 to 15 requests a minute for this model class, so click through the batches, do not
// script them, and expect a rate limit if you do. Nothing is ever sent: outbound sending
// stays off.
//
// Not run in Phase 3a: no key was used and no model call was made.
await startStack({ provider: 'gemini', tag: 'live' });
