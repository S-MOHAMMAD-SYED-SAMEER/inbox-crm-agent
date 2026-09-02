import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createMockLlmProvider, MockResponseNotFoundError, createLlmProvider } from '../src/adapters/llm/index.ts';
import { hashRequest } from '../src/adapters/llm/mock.ts';
import type { LlmRequest } from '../src/adapters/llm/types.ts';
import { createDemoEmailSource, parseDemoFixtures } from '../src/adapters/email/index.ts';
import type { EmailSource } from '../src/adapters/email/types.ts';
import { createLocalCrmReader } from '../src/adapters/crm/index.ts';
import type { CrmReader } from '../src/adapters/crm/types.ts';
import { loadConfig } from '../src/config/env.ts';

// Adapter conformance.
//
// Each interface has one suite, written against the interface rather than an
// implementation, and run against every implementation that exists. Today that
// is one each. When the Gmail and HubSpot adapters are written, the suite they
// must satisfy is already here — which is the whole payoff of drawing these
// boundaries before the integrations exist.

// ============================================================ LLM provider

const SAMPLE_REQUEST: LlmRequest = {
  purpose: 'understand',
  promptVersion: 'understand.v1',
  systemPrompt: 'You classify business email.',
  messages: [{ role: 'user', content: 'Could you tell us roughly how much this would cost?' }],
  tool: {
    name: 'record_understanding',
    description: 'Record the structured reading of this email.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' } } },
  },
};

test('the mock provider is deterministic across repeated calls', async () => {
  const provider = createMockLlmProvider();
  provider.register('E-01', { toolInput: { category: 'sales_inquiry', confidence: 0.91 } });

  const request = { ...SAMPLE_REQUEST, metadata: { fixtureId: 'E-01' } };
  const results = await Promise.all([provider.complete(request), provider.complete(request), provider.complete(request)]);

  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(results[0]?.latencyMs, 0, 'real elapsed time would make the fixture non-deterministic');
  assert.equal(results[0]?.stopReason, 'tool_use');
});

test('a caller mutating a response cannot poison the next one', async () => {
  const provider = createMockLlmProvider();
  provider.register('E-01', { toolInput: { category: 'sales_inquiry' } });
  const request = { ...SAMPLE_REQUEST, metadata: { fixtureId: 'E-01' } };

  const first = await provider.complete(request);
  (first.toolInput as Record<string, unknown>).category = 'spam';

  const second = await provider.complete(request);
  assert.equal(second.toolInput.category, 'sales_inquiry');
});

test('an unregistered request throws instead of inventing output', async () => {
  const provider = createMockLlmProvider();
  const err = await rejects(() => provider.complete(SAMPLE_REQUEST));

  assert.ok(err instanceof MockResponseNotFoundError);
  assert.match(err.message, /never invents output/);
});

test('a response can be pinned to an exact request without a fixture id', async () => {
  const provider = createMockLlmProvider();
  provider.registerForRequest(SAMPLE_REQUEST, { toolInput: { category: 'spam' } });

  const result = await provider.complete(SAMPLE_REQUEST);
  assert.equal(result.toolInput.category, 'spam');
});

test('request hashing ignores routing metadata but not content', () => {
  const withMetadata = { ...SAMPLE_REQUEST, metadata: { fixtureId: 'E-01' } };
  assert.equal(hashRequest(SAMPLE_REQUEST), hashRequest(withMetadata));

  const different = { ...SAMPLE_REQUEST, messages: [{ role: 'user' as const, content: 'something else' }] };
  assert.notEqual(hashRequest(SAMPLE_REQUEST), hashRequest(different));
});

test('the mock records every call it was asked to make', async () => {
  const provider = createMockLlmProvider({ 'E-01': { toolInput: {} } });
  await provider.complete({ ...SAMPLE_REQUEST, metadata: { fixtureId: 'E-01' } });

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.purpose, 'understand');
  assert.equal(provider.calls[0]?.toolName, 'record_understanding');
});

// CONTRACT CHANGE (M1): the Anthropic provider is now implemented, so this no
// longer asserts "not built". The property it was really protecting — that a
// provider which cannot run refuses instead of quietly becoming the mock — is
// unchanged and is what is asserted here now.
test('a provider that cannot run refuses rather than falling back to the mock', () => {
  const unconfigured = loadConfig({ LLM_PROVIDER: 'anthropic' });
  assert.throws(() => createLlmProvider(unconfigured.config), /no API key is configured/);

  const gemini = loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'x' });
  assert.throws(() => createLlmProvider(gemini.config), /not implemented for this project/);
});

test('a configured Anthropic provider is selected, and is not the mock', () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-placeholder' });
  const provider = createLlmProvider(config);
  assert.equal(provider.name, 'anthropic');
  assert.equal(provider.configured, true);
});

// ============================================================ email source

/** The conformance suite every EmailSource implementation must satisfy. */
function emailSourceConformance(label: string, build: () => EmailSource): void {
  test(`${label}: returns canonical messages, oldest first`, async () => {
    const source = build();
    const { messages } = await source.fetchNew('2000-01-01T00:00:00.000Z');

    assert.ok(messages.length >= 2, 'the suite needs at least two fixtures to check ordering');
    for (let i = 1; i < messages.length; i++) {
      assert.ok(
        (messages[i]?.receivedAt as string) >= (messages[i - 1]?.receivedAt as string),
        'an inbox processed newest-first would answer a follow-up before the enquiry it follows',
      );
    }

    const first = messages[0];
    assert.ok(first);
    for (const field of ['provider', 'providerMessageId', 'fromEmail', 'toEmail', 'subject', 'bodyText', 'receivedAt'] as const) {
      assert.ok(field in first, `canonical message is missing "${field}"`);
    }
    assert.equal(typeof first.headers, 'object');
  });

  test(`${label}: honours the since filter`, async () => {
    const source = build();
    const all = await source.fetchNew('2000-01-01T00:00:00.000Z');
    const cutoff = all.messages[0]?.receivedAt as string;

    const later = await source.fetchNew(cutoff);
    assert.ok(later.messages.every((message) => message.receivedAt > cutoff));
  });

  test(`${label}: does not re-offer a message once it is processed`, async () => {
    const source = build();
    const before = await source.fetchNew('2000-01-01T00:00:00.000Z');
    const target = before.messages[0];
    assert.ok(target);

    await source.markProcessed(target.providerMessageId);

    const after = await source.fetchNew('2000-01-01T00:00:00.000Z');
    assert.ok(!after.messages.some((message) => message.providerMessageId === target.providerMessageId));
  });

  test(`${label}: paginates without skipping or repeating`, async () => {
    const source = build();
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const result: { messages: Array<{ providerMessageId: string }>; cursor?: string } = await source.fetchNew(
        '2000-01-01T00:00:00.000Z',
        cursor === undefined ? { limit: 1 } : { limit: 1, cursor },
      );
      seen.push(...result.messages.map((message) => message.providerMessageId));
      if (result.cursor === undefined) break;
      cursor = result.cursor;
    }

    assert.equal(new Set(seen).size, seen.length, 'pagination repeated a message');
    const all = await source.fetchNew('2000-01-01T00:00:00.000Z');
    assert.equal(seen.length, all.messages.length, 'pagination skipped a message');
  });

  test(`${label}: read-only sources expose no send capability`, () => {
    const source = build();
    assert.equal(source.send, undefined, 'nothing in this build may deliver mail');
  });
}

emailSourceConformance('demo source (file)', () =>
  createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
);

test('demo fixtures are rejected when malformed, listing every problem', () => {
  try {
    parseDemoFixtures(
      [
        { providerMessageId: 'a', fromEmail: 'not-an-email', toEmail: 'x@y.com', subject: 's', bodyText: 'b', receivedAt: '2026-01-01T00:00:00.000Z' },
        { providerMessageId: 'a', fromEmail: 'a@b.com', toEmail: 'x@y.com', subject: 's', bodyText: 'b', receivedAt: 'nonsense' },
      ],
      'test.json',
    );
    assert.fail('expected the fixtures to be rejected');
  } catch (err) {
    const problems = (err as { details?: { problems?: string[] } }).details?.problems ?? [];
    assert.ok(problems.length >= 3, `expected several problems, got ${problems.length}`);
    assert.ok(problems.some((problem) => /duplicate providerMessageId/.test(problem)));
    assert.ok(problems.some((problem) => /fromEmail/.test(problem)));
    assert.ok(problems.some((problem) => /receivedAt/.test(problem)));
  }
});

test('the shipped demo fixtures parse', () => {
  const source = createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') });
  assert.equal(source.name, 'demo');
});

// ============================================================ CRM reader

function crmReaderConformance(label: string, build: () => Promise<{ reader: CrmReader; close: () => Promise<void>; seed: (r: Awaited<ReturnType<typeof createTestContext>>['repos']) => Promise<void> }>): void {
  test(`${label}: declares whether it can apply a plan atomically`, async () => {
    const { reader, close } = await build();
    assert.equal(typeof reader.supportsAtomicity, 'boolean');
    await close();
  });

  test(`${label}: finds a contact by email, case-insensitively`, async () => {
    const { reader, close } = await build();
    const found = await reader.findContactByEmail('ELENA@harborview.invalid');
    assert.ok(found);
    assert.equal(found.fullName, 'Elena Marsh');
    await close();
  });

  test(`${label}: returns null rather than guessing when there is no match`, async () => {
    const { reader, close } = await build();
    assert.equal(await reader.findContactByEmail('nobody@nowhere.example'), null);
    assert.equal(await reader.findCompanyByDomain('nowhere.example'), null);
    assert.deepEqual(await reader.searchCompaniesByName('No Such Company'), []);
    await close();
  });

  test(`${label}: finds a company by domain`, async () => {
    const { reader, close } = await build();
    const found = await reader.findCompanyByDomain('harborview.invalid');
    assert.ok(found);
    assert.equal(found.name, 'Harborview Digital');
    await close();
  });

  test(`${label}: searches companies by normalised name`, async () => {
    const { reader, close } = await build();
    // Raw, un-normalised input must work: normalising twice is a no-op.
    const found = await reader.searchCompaniesByName('Harborview Media Ltd');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.domain, 'harborviewmedia.invalid');
    await close();
  });

  test(`${label}: returns a stable, newest-first timeline`, async () => {
    const { reader, close } = await build();
    const contact = await reader.findContactByEmail('elena@harborview.invalid');
    assert.ok(contact);

    const timeline = await reader.getTimeline('contact', contact.id);
    assert.ok(timeline.length >= 2);
    for (let i = 1; i < timeline.length; i++) {
      assert.ok((timeline[i - 1]?.occurredAt as string) >= (timeline[i]?.occurredAt as string));
    }

    const again = await reader.getTimeline('contact', contact.id);
    assert.deepEqual(timeline, again, 'a timeline that reshuffles between identical reads looks broken');
    await close();
  });
}

crmReaderConformance('local CRM reader', async () => {
  const ctx = await createTestContext();
  const company = await ctx.repos.companies.create({ name: 'Harborview Digital', domain: 'harborview.invalid', source: 'seed' });
  await ctx.repos.companies.create({ name: 'Harborview Media Ltd', domain: 'harborviewmedia.invalid', source: 'seed' });
  const contact = await ctx.repos.contacts.create({
    fullName: 'Elena Marsh', email: 'elena@harborview.invalid', companyId: company.id, source: 'seed',
  });
  await ctx.repos.activities.create({
    type: 'email_in', subject: 'First', occurredAt: '2026-08-01T00:00:00.000Z', contactId: contact.id, source: 'seed',
  });
  await ctx.repos.notes.create({ body: 'A note', author: 'Sameer', contactId: contact.id, source: 'seed' });

  return {
    reader: createLocalCrmReader(ctx.repos),
    close: ctx.close,
    seed: async () => undefined,
  };
});

test('the local CRM reader claims atomicity, which its transaction actually provides', async () => {
  const ctx = await createTestContext();
  const reader = createLocalCrmReader(ctx.repos);
  assert.equal(reader.supportsAtomicity, true);
  assert.equal(reader.name, 'local');
  await ctx.close();
});
