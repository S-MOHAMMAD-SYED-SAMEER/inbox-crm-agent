import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/lib/password.ts';
import type { AppConfig, LlmProviderName } from '../../src/config/env.ts';
import { DEFAULT_ANTHROPIC_TEMPERATURE, DEFAULT_GEMINI_TEMPERATURE } from '../../src/adapters/llm/defaults.ts';

// The whole local stack in one command, shared by `npm run demo` (the scripted mock
// model) and `npm run live` (the real Gemini model).
//
// What it does, in order:
//   1. Says which provider and model it is about to use, and refuses to start a real
//      provider that has no key (before it touches the database). The key itself is
//      never printed, not even in part.
//   2. Resets the demo database to its seeded starting state (`scripts/reset.ts`).
//   3. Starts the app, which serves the dashboard on the same origin as the API.
//
// It adds no behaviour of its own to the application. LLM_PROVIDER is FORCED rather than
// defaulted: a stray LLM_PROVIDER in `.env` must not turn the keyless demo into a script
// that asks for a key, nor `npm run live` into one that quietly replays fixtures.
//
// A variable already set in the environment wins over `.env` (Node's `loadEnvFile` never
// overrides), so a GEMINI_API_KEY left in the Windows user environment from other work
// will be used instead of the one in `server/.env`. This script prints which provider and
// model it is using, but cannot tell you which source the key came from.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO_DATABASE = path.join(SERVER_ROOT, 'data', 'demo-local.sqlite');

/** The line printed at start-up. Provider and model only; whether a key is set, never its value. */
export function describeProvider(cfg: Pick<AppConfig, 'llmProvider' | 'geminiModel' | 'anthropicModel' | 'geminiApiKey' | 'anthropicApiKey' | 'llmTemperature'>): string {
  if (cfg.llmProvider === 'mock') {
    return '[demo] Provider: mock (scripted replies, no model, no key).';
  }
  const model = cfg.llmProvider === 'gemini' ? cfg.geminiModel : cfg.anthropicModel;
  const key = cfg.llmProvider === 'gemini' ? cfg.geminiApiKey : cfg.anthropicApiKey;
  const temperature =
    cfg.llmTemperature ?? (cfg.llmProvider === 'gemini' ? DEFAULT_GEMINI_TEMPERATURE : DEFAULT_ANTHROPIC_TEMPERATURE);
  return `[live] Provider: ${cfg.llmProvider}, model: ${model}, temperature: ${temperature} (API key ${key ? 'is set' : 'is NOT set'}).`;
}

/** What stops a real provider from starting: its key. Null when it can run. */
export function missingKeyMessage(cfg: Pick<AppConfig, 'llmProvider' | 'geminiApiKey' | 'anthropicApiKey'>): string | null {
  if (cfg.llmProvider === 'gemini' && !cfg.geminiApiKey) {
    return 'GEMINI_API_KEY is not set. `npm run live` talks to the real Gemini API, so it needs a key: add GEMINI_API_KEY to server/.env (see server/.env.example), or set it in your shell. Use `npm run demo` for the keyless version.';
  }
  if (cfg.llmProvider === 'anthropic' && !cfg.anthropicApiKey) {
    return 'ANTHROPIC_API_KEY is not set (see server/.env.example).';
  }
  return null;
}

export async function startStack({ provider, tag }: { provider: LlmProviderName; tag: 'demo' | 'live' }): Promise<never> {
  process.env.LLM_PROVIDER = provider;
  // Imported only now, so the provider above is what the config reads (and `.env` is loaded here).
  const { config } = await import('../../src/config/env.ts');

  console.log(describeProvider(config));
  const problem = missingKeyMessage(config);
  if (problem) {
    console.error(`[${tag}] Not starting: ${problem}`);
    process.exit(1);
  }

  const password = randomBytes(8).toString('hex');
  const port = process.env.PORT?.trim() || '3100';

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: port,
    DATABASE_URL: '',
    SQLITE_PATH: DEMO_DATABASE,
    LLM_PROVIDER: provider,
    EMAIL_SOURCE: 'demo',
    ALLOW_OUTBOUND_SEND: 'false',
    COOKIE_SECURE: 'false',
    OPERATOR_PASSWORD_HASH: await hashPassword(password),
  };

  const run = (script: string): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { cwd: SERVER_ROOT, env, stdio: 'inherit' });
      child.on('error', () => resolve(1));
      child.on('exit', (code) => resolve(code ?? 1));
    });

  const resetCode = await run('scripts/reset.ts');
  if (resetCode !== 0) process.exit(resetCode);

  console.log(`\n[${tag}] Open http://localhost:${port}`);
  console.log(`[${tag}] Sign in with this password (made for this run, local only): ${password}\n`);
  if (provider !== 'mock') {
    console.log(
      `[${tag}] Every email you ingest, analyse and decide is a real model request (about 1 to 2 each, up to 24 for the ten demo emails). Nothing is ever sent.\n`,
    );
  }

  process.exit(await run('src/index.ts'));
}
