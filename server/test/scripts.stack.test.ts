import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.ts';
import { describeProvider, missingKeyMessage } from '../scripts/lib/stack.ts';

// `npm run demo` and `npm run live` share one launcher. What is tested here is what must
// never go wrong with the real-model one: it says which provider and model it will use,
// it never prints a key, and it refuses to start without one. Nothing here starts a server
// or makes a model call.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_KEY = 'AIza-FAKE-KEY-FOR-A-TEST-0123456789';

test('the start-up line names the provider and model and never contains the key', () => {
  const gemini = loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }).config;
  const line = describeProvider(gemini);
  assert.match(line, /^\[live\] Provider: gemini, model: gemini-3\.5-flash-lite, temperature: 1 \(API key is set\)\.$/);
  assert.ok(!line.includes(FAKE_KEY));
  assert.ok(!line.includes('AIza'));

  const unset = describeProvider(loadConfig({ LLM_PROVIDER: 'gemini' }).config);
  assert.match(unset, /API key is NOT set/);

  assert.match(describeProvider(loadConfig({ LLM_PROVIDER: 'mock' }).config), /mock \(scripted replies, no model, no key\)/);
  assert.match(
    describeProvider(loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: 'gemini-x', LLM_TEMPERATURE: '0.3' }).config),
    /model: gemini-x, temperature: 0\.3/,
  );
});

test('a real provider with no key cannot start, and the message tells how to fix it without naming a value', () => {
  assert.match(missingKeyMessage(loadConfig({ LLM_PROVIDER: 'gemini' }).config) ?? '', /GEMINI_API_KEY is not set/);
  assert.match(missingKeyMessage(loadConfig({ LLM_PROVIDER: 'anthropic' }).config) ?? '', /ANTHROPIC_API_KEY is not set/);
  assert.equal(missingKeyMessage(loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }).config), null);
  assert.equal(missingKeyMessage(loadConfig({ LLM_PROVIDER: 'mock' }).config), null);
});

test('npm run live refuses to start without GEMINI_API_KEY: exit 1, a clear message, no URL, no password', () => {
  // An empty value in the environment wins over any `.env`, so this holds on a machine that has a key file.
  const result = spawnSync(process.execPath, ['scripts/live.ts'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, GEMINI_API_KEY: '', LLM_PROVIDER: 'mock', PORT: '0' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[live\] Provider: gemini, model: gemini-3\.5-flash-lite/);
  assert.match(result.stdout, /API key is NOT set/);
  assert.match(result.stderr, /Not starting: GEMINI_API_KEY is not set/);
  assert.ok(!/Open http/.test(result.stdout), 'it started anyway');
  assert.ok(!/password/i.test(result.stdout));
});

test('the package scripts exist and live is not the demo', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.live, 'node scripts/live.ts');
  assert.equal(pkg.scripts.demo, 'node scripts/demo.ts');
  const live = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'live.ts'), 'utf8');
  const demo = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'demo.ts'), 'utf8');
  assert.match(live, /provider: 'gemini'/);
  assert.match(demo, /provider: 'mock'/);
});
