import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures, createLlmProvider } from '../src/adapters/llm/index.ts';
import {
  createAnthropicProvider,
  toAnthropicRequest,
  parseAnthropicResponse,
  type AnthropicLike,
} from '../src/adapters/llm/anthropic.ts';
import { LlmUnavailableError } from '../src/adapters/llm/types.ts';
import { UNDERSTAND_TOOL } from '../src/agent/understand/schema.ts';
import {
  handleGetEmail,
  handleIngest,
  handleListEmails,
  handleUnderstandEmail,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import { runEvaluation, loadDataset } from '../src/eval/understand/runner.ts';
import { thresholdFailures } from '../src/eval/understand/metrics.ts';
import { loadConfig } from '../src/config/env.ts';
import { createLogger } from '../src/lib/logger.ts';
import type { LlmRequest } from '../src/adapters/llm/types.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

const quiet = createLogger('test', { level: 'error' });

function deps(repos: Repositories) {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider,
    logger: quiet,
  };
}

// ========================================================= Anthropic provider
//
// Covered without credentials by injecting a stub client. What cannot be
// verified this way is the wire contract itself; that is stated in the README
// rather than implied by a green test.

const SAMPLE_REQUEST: LlmRequest = {
  purpose: 'understand',
  promptVersion: 'understand.v1',
  systemPrompt: 'You read business email.',
  messages: [{ role: 'user', content: 'the email' }],
  tool: UNDERSTAND_TOOL,
  maxTokens: 1024,
};

test('the Anthropic request forces the tool call rather than merely offering it', () => {
  const request = toAnthropicRequest(SAMPLE_REQUEST, 'claude-haiku-4-5-20251001');

  assert.deepEqual(request.tool_choice, { type: 'tool', name: 'record_understanding' });
  assert.equal(request.tools?.length, 1);
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.system, 'You read business email.');
  assert.equal(request.max_tokens, 1024);
});

test('a tool-use response is parsed into its structured input', () => {
  const parsed = parseAnthropicResponse(
    {
      content: [{ type: 'tool_use', id: 't1', name: 'record_understanding', input: { category: 'spam' } }],
      stop_reason: 'tool_use',
      model: 'claude-haiku-4-5-20251001',
    } as never,
    'record_understanding',
  );
  assert.deepEqual(parsed, { category: 'spam' });
});

test('a response with no tool call is a failure, not an empty reading', () => {
  // A refusal, a stop sequence and a max-tokens cut-off all land here. Treating
  // any of them as "the model had nothing to say" would silently produce an
  // email with no analysis and no error.
  assert.throws(
    () =>
      parseAnthropicResponse(
        { content: [{ type: 'text', text: 'I cannot help with that.' }], stop_reason: 'end_turn', model: 'm' } as never,
        'record_understanding',
      ),
    LlmUnavailableError,
  );
});

test('a tool call with a non-object argument is rejected', () => {
  assert.throws(
    () =>
      parseAnthropicResponse(
        { content: [{ type: 'tool_use', id: 't', name: 'record_understanding', input: 'oops' }], stop_reason: 'tool_use', model: 'm' } as never,
        'record_understanding',
      ),
    LlmUnavailableError,
  );
});

test('an SDK error becomes a provider-unavailable error, not a silent fallback', async () => {
  const client: AnthropicLike = {
    messages: {
      create: async () => {
        throw new Error('429 rate_limit_error');
      },
    },
  };
  const provider = createAnthropicProvider({ client, model: 'claude-haiku-4-5-20251001' });

  const err = await rejects(() => provider.complete(SAMPLE_REQUEST));
  assert.ok(err instanceof LlmUnavailableError);
  assert.match(err.message, /could not be reached/);
});

test('the provider reports latency and the model the API actually used', async () => {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          content: [{ type: 'tool_use', id: 't', name: 'record_understanding', input: { category: 'spam' } }],
          stop_reason: 'tool_use',
          model: 'claude-haiku-4-5-20251001',
        }) as never,
    },
  };

  const result = await createAnthropicProvider({ client }).complete(SAMPLE_REQUEST);
  assert.equal(result.model, 'claude-haiku-4-5-20251001');
  assert.equal(result.stopReason, 'tool_use');
  assert.ok(result.latencyMs >= 0);
});

test('an unconfigured Anthropic provider refuses rather than falling back to the mock', async () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic' });
  assert.throws(() => createLlmProvider(config), /no API key is configured/);

  const provider = createAnthropicProvider({ cfg: loadConfig({}).config });
  assert.equal(provider.configured, false);
  const err = await rejects(() => provider.complete(SAMPLE_REQUEST));
  assert.ok(err instanceof LlmUnavailableError);
});

test('provider errors never leak the API key', async () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-super-secret' });
  const client: AnthropicLike = {
    messages: {
      create: async () => {
        throw new Error('401 invalid x-api-key');
      },
    },
  };
  const err = await rejects(() => createAnthropicProvider({ client, cfg: config }).complete(SAMPLE_REQUEST));
  assert.doesNotMatch(err.message, /sk-ant/);
});

test('the mock provider stays the default', () => {
  const provider = createLlmProvider(loadConfig({}).config);
  assert.equal(provider.name, 'mock');
});

test('gemini is refused for this project rather than half-supported', () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'x' });
  assert.throws(() => createLlmProvider(config), /not implemented for this project/);
});

test('the demo fixtures register a canned response per email, plus the drafts', () => {
  // CONTRACT CHANGE (M3): DECIDE asks for `<id>:draft`, so the four draftable
  // fixtures each register a second response alongside their understanding.
  const provider = createMockLlmProvider();
  assert.equal(registerDemoFixtures(provider, DEMO_DATA_DIR), 14);
});

// ================================================================== handlers

test('ingest then list surfaces every email with no analysis yet', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);

  const ingested = await handleIngest(d, {});
  assert.equal(ingested.status, 200);
  assert.equal(ingested.body.ingested, 10);
  assert.equal(ingested.body.duplicates, 0);

  const listed = await handleListEmails(d, {});
  assert.equal(listed.body.emails.length, 10);
  assert.ok(listed.body.emails.every((email) => email.analysis === null));
  await close();
});

test('ingesting twice reports duplicates rather than creating them', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});
  const again = await handleIngest(d, {});

  assert.equal(again.body.ingested, 0);
  assert.equal(again.body.duplicates, 10);
  await close();
});

test('an invalid limit is a validation error listing the problem', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleIngest(deps(repos), { limit: 0 }));
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  await close();
});

test('an unknown state filter is rejected rather than silently ignored', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleListEmails({ repos }, { state: 'imaginary' }));
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
  await close();
});

test('the detail payload states that later stages are not implemented', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});
  const [first] = (await handleListEmails(d, {})).body.emails;

  const detail = await handleGetEmail(d, (first as { id: string }).id);
  assert.equal(detail.body.stages.understand, 'pending');
  // CONTRACT CHANGE (M3): `decide` became a real stage status. `execute` is
  // still the unbuilt one, and the property under test — that an unrun stage
  // reports itself honestly rather than showing invented output — is unchanged.
  assert.equal(detail.body.stages.decide, 'pending');
  // CONTRACT CHANGE (M4-A): `execute` became a real stage status too. The
  // property under test is unchanged — an unrun stage reports itself honestly.
  assert.equal(detail.body.stages.execute, 'pending');
  assert.equal(detail.body.analysis, null, 'an unanalysed email has no analysis, not a fabricated one');
  await close();
});

test('understanding one email fills in its analysis and audit trail', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});
  const email = await repos.emails.findByProviderMessageId('demo', 'demo-e01');

  const detail = await handleUnderstandEmail(d, (email as { id: string }).id);
  assert.equal(detail.body.stages.understand, 'complete');
  assert.equal(detail.body.analysis?.understanding.category, 'sales_inquiry');
  assert.ok(detail.body.audit.length >= 4);
  await close();
});

test('understanding a missing email is a 404, not a crash', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleUnderstandEmail(deps(repos), 'no-such-id'));
  assert.equal((err as { code?: string }).code, 'NOT_FOUND');
  await close();
});

test('the batch endpoint processes everything waiting and reports the outcome', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});

  const result = await handleUnderstandPending(d, {});
  assert.equal(result.body.processed, 10);
  assert.equal(result.body.failed, 0);

  const listed = await handleListEmails(d, {});
  assert.ok(listed.body.emails.every((email) => email.analysis !== null));

  const review = await handleListEmails(d, { state: 'needs_review' });
  assert.equal(review.body.emails.length, 2, 'the ambiguous and injected cases go to a person');
  await close();
});

test('a list summary never carries the email body', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});
  await handleUnderstandPending(d, {});

  const listed = await handleListEmails(d, {});
  assert.doesNotMatch(JSON.stringify(listed.body), /We run a small Shopify store/);
  await close();
});

// ============================================================== evaluation

test('the evaluation dataset loads and validates', () => {
  const dataset = loadDataset(path.join(MIGRATIONS_DIR, '..', 'eval', 'understand.dataset.json'));
  assert.equal(dataset.cases.length, 10);
  assert.ok(dataset.version.length > 0);
});

test('the evaluation passes every threshold, deterministically', async () => {
  const options = {
    datasetPath: path.join(MIGRATIONS_DIR, '..', 'eval', 'understand.dataset.json'),
    demoDataDir: DEMO_DATA_DIR,
    migrationsDir: MIGRATIONS_DIR,
  };

  const first = await runEvaluation(options);
  assert.equal(first.metrics.cases, 10);
  assert.equal(first.metrics.passed, 10);
  assert.deepEqual(thresholdFailures(first.metrics), []);
  assert.equal(first.metrics.hallucinatedFieldRate, 0);
  assert.equal(first.metrics.provenanceCompleteness, 1);
  assert.equal(first.metrics.injectionContainment, 1);

  // Same inputs, same numbers — a diff between runs means a behaviour change.
  const second = await runEvaluation(options);
  assert.deepEqual(second.metrics, first.metrics);
});
