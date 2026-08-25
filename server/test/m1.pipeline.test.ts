import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { understandEmail, assertUnderstandable } from '../src/agent/understand/understand.ts';
import { createLogger } from '../src/lib/logger.ts';
import { emptyExtraction } from '../src/domain/understanding.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/adapters/llm/types.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';
import path from 'node:path';

// M1 integration tests: the real pipeline against a real (in-memory) schema,
// with only the model call substituted. No credentials, no network, no clock
// drift — the same arrangement the eval runner uses.

const quiet = createLogger('test', { level: 'error' });

async function ingestDemo(repos: Repositories): Promise<EmailRecord[]> {
  const source = createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') });
  const result = await ingestEmails({ repos, source, logger: quiet });
  return result.ingested;
}

function demoProvider() {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return provider;
}

async function emailFor(repos: Repositories, providerMessageId: string): Promise<EmailRecord> {
  const email = await repos.emails.findByProviderMessageId('demo', providerMessageId);
  assert.ok(email, `fixture ${providerMessageId} was not ingested`);
  return email;
}

/** A provider that returns exactly what a test tells it to. */
function scriptedProvider(script: (request: LlmRequest, call: number) => LlmResponse | Error): LlmProvider {
  let calls = 0;
  return {
    name: 'mock',
    configured: true,
    async complete(request) {
      calls++;
      const result = script(request, calls);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function response(toolInput: Record<string, unknown>): LlmResponse {
  return { toolInput, model: 'mock', latencyMs: 0, stopReason: 'tool_use' };
}

function goodOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'sales_inquiry',
    intent: 'Wants a chatbot.',
    priority: 'high',
    priorityReason: 'Direct question about cost.',
    confidence: 0.9,
    flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: false },
    extracted: {
      ...emptyExtraction(),
      contactName: { value: 'Sarah Williams', confidence: 0.9, sourceSpan: 'Sarah Williams' },
    },
    questionAsked: null,
    summary: 'Chatbot enquiry.',
    ...overrides,
  };
}

// ================================================================= ingestion

test('ingesting the demo dataset stores all ten messages, sanitised', async () => {
  const { repos, close } = await createTestContext();
  const ingested = await ingestDemo(repos);

  assert.equal(ingested.length, 10);
  assert.equal(await repos.emails.count(), 10);
  for (const email of ingested) {
    assert.equal(email.state, 'received');
    assert.doesNotMatch(email.bodyText, /<script|<img/i);
  }
  await close();
});

test('re-ingesting is a no-op rather than a second copy of every lead', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const second = await ingestEmails(
    { repos, source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }), logger: quiet },
    {},
  );

  assert.equal(second.ingested.length, 0);
  assert.equal(second.duplicates, 10);
  assert.equal(await repos.emails.count(), 10);
  await close();
});

test('ingestion audits every message, and sanitisation only when it did something', async () => {
  const { repos, close } = await createTestContext();
  const source = createDemoEmailSource({
    fixtures: [
      {
        provider: 'demo', providerMessageId: 'plain', threadId: null, fromName: 'A', fromEmail: 'a@x.test',
        toEmail: 'hello@y.test', cc: null, subject: 'Plain', bodyText: 'Just text.', headers: {},
        receivedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        provider: 'demo', providerMessageId: 'html', threadId: null, fromName: 'B', fromEmail: 'b@x.test',
        toEmail: 'hello@y.test', cc: null, subject: 'Rich',
        bodyText: '<p>Hi</p><img src="https://t.example/p.gif">', headers: {},
        receivedAt: '2026-08-02T00:00:00.000Z',
      },
    ],
  });

  const { ingested } = await ingestEmails({ repos, source, logger: quiet });
  const plain = ingested.find((email) => email.providerMessageId === 'plain') as EmailRecord;
  const html = ingested.find((email) => email.providerMessageId === 'html') as EmailRecord;

  const plainEvents = (await repos.audit.listByEmail(plain.id)).map((event) => event.eventType);
  const htmlEvents = (await repos.audit.listByEmail(html.id)).map((event) => event.eventType);

  assert.deepEqual(plainEvents, ['email_received']);
  assert.deepEqual(htmlEvents, ['email_received', 'content_sanitised']);
  await close();
});

test('an ingestion audit summary names the domain, not the sender address', async () => {
  const { repos, close } = await createTestContext();
  const [email] = await ingestDemo(repos);
  const events = await repos.audit.listByEmail((email as EmailRecord).id);
  const received = events.find((event) => event.eventType === 'email_received');

  assert.ok(received);
  assert.doesNotMatch(received.summary, /sarah@|@acmecommerce\.io/);
  await close();
});

// =============================================================== understand

test('the hero lead is read exactly as the specification describes', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const outcome = await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });
  const understanding = outcome.understanding;
  assert.ok(understanding);

  assert.equal(understanding.category, 'sales_inquiry');
  assert.equal(understanding.priority, 'high');
  assert.equal(understanding.confidence, 0.91);
  assert.equal(understanding.confidenceBand, 'high');
  assert.equal(understanding.extracted.contactName.value, 'Sarah Williams');
  assert.equal(understanding.extracted.companyName.value, 'Acme Commerce');
  assert.equal(understanding.extracted.serviceInterest.value, 'AI Customer Support');
  assert.equal(understanding.extracted.budget.value, null, 'no budget was stated');
  assert.equal(understanding.extracted.timeline.value, null, 'no timeline was stated');
  assert.equal(outcome.state, 'resolving');
  await close();
});

test('every surviving value carries evidence that appears in the email', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const provider = demoProvider();

  for (const id of ['demo-e01', 'demo-e03', 'demo-e05', 'demo-e06']) {
    const email = await emailFor(repos, id);
    const outcome = await understandEmail(email, { repos, provider, logger: quiet });
    const corpus = `${email.fromName ?? ''}\n${email.fromEmail}\n${email.subject}\n${email.bodyText}`
      .replace(/\s+/g, ' ')
      .toLowerCase();

    for (const [field, value] of Object.entries(outcome.understanding?.extracted ?? {})) {
      if (value.value === null) continue;
      assert.ok(value.sourceSpan, `${id}.${field} kept a value with no evidence`);
      assert.ok(
        corpus.includes((value.sourceSpan as string).replace(/\s+/g, ' ').toLowerCase()),
        `${id}.${field} cited evidence that is not in the email`,
      );
    }
  }
  await close();
});

test('an invented budget is discarded and the discard is auditable', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e02');

  const outcome = await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  assert.equal(outcome.understanding?.extracted.budget.value, null);
  assert.equal(outcome.validation.droppedFields.length, 1);
  assert.equal(outcome.validation.droppedFields[0]?.field, 'budget');
  assert.equal(outcome.validation.droppedFields[0]?.claimedValue, '$5,000');

  // The model's own answer is preserved alongside, so the difference is a diff
  // rather than an opinion.
  const analysis = await repos.analyses.getLatestForEmail(email.id);
  assert.ok(analysis);
  const asModelSaidIt = analysis.modelOutput as { extracted: Record<string, { value: string }> };
  assert.equal(asModelSaidIt.extracted.budget?.value, '$5,000');
  assert.equal(analysis.understanding.extracted.budget.value, null);

  const events = await repos.audit.listByEmail(email.id);
  assert.ok(events.some((event) => event.eventType === 'field_dropped_no_provenance'));
  await close();
});

test('an ambiguous email stays uncertain and goes to a person', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e08');

  const outcome = await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  assert.equal(outcome.understanding?.category, 'ambiguous');
  assert.equal(outcome.understanding?.confidenceBand, 'low');
  assert.equal(outcome.understanding?.flags.ambiguousIntent, true);
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'ambiguous_intent');
  await close();
});

test('spam is recognised without becoming a lead', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e09');

  const outcome = await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });
  assert.equal(outcome.understanding?.category, 'spam');
  assert.equal(outcome.understanding?.extracted.companyName.value, null);
  await close();
});

// ========================================================= prompt injection

test('a prompt injection is caught even though the model was fooled', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e10');

  const outcome = await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  // The canned response deliberately reports a clean sales inquiry.
  const modelSaid = outcome.analysis?.modelOutput as { flags: { possibleInjection: boolean } };
  assert.equal(modelSaid.flags.possibleInjection, false, 'this case is only meaningful if the model missed it');

  // Deterministic code is authoritative.
  assert.equal(outcome.security.injection.suspected, true);
  assert.equal(outcome.security.injection.modelFlagged, false);
  assert.equal(outcome.understanding?.flags.possibleInjection, true);
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'possible_injection');

  const rules = outcome.security.injection.matches.map((match) => match.rule);
  for (const expected of ['instruction_override', 'role_marker', 'autonomy_escalation', 'concealment']) {
    assert.ok(rules.includes(expected), `expected rule ${expected}, got ${rules.join(', ')}`);
  }

  const events = await repos.audit.listByEmail(email.id);
  assert.ok(events.some((event) => event.eventType === 'injection_suspected'));
  await close();
});

test('an injected email causes no CRM write and no outbound message', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e10');
  await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  // Nothing in M1 can act, and the injection asked for exactly the actions that
  // do not exist yet. Asserted rather than assumed.
  assert.equal(await repos.contacts.count(), 0);
  assert.equal(await repos.companies.count(), 0);
  assert.equal(await repos.deals.count(), 0);
  assert.equal(await repos.tasks.count(), 0);

  const outbox = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_messages');
  assert.equal(Number(outbox[0]?.n), 0);
  const decisions = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM decisions');
  assert.equal(Number(decisions[0]?.n), 0);
  await close();
});

test('understanding any email writes nothing to the CRM', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const provider = demoProvider();

  for (const email of await repos.emails.list({ limit: 50 })) {
    await understandEmail(email, { repos, provider, logger: quiet });
  }

  assert.equal(await repos.contacts.count(), 0, 'UNDERSTAND must never create CRM records');
  assert.equal(await repos.companies.count(), 0);
  assert.equal(await repos.deals.count(), 0);
  await close();
});

// ================================================================ failures

test('a provider failure is visible as a failure, with nothing persisted', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const provider = scriptedProvider(() => new Error('connect ECONNREFUSED 10.0.0.1:443'));
  const outcome = await understandEmail(email, { repos, provider, logger: quiet });

  assert.equal(outcome.state, 'understand_failed');
  assert.equal(outcome.analysis, null);
  assert.equal(await repos.analyses.count(), 0, 'a failed call must not leave a half-written analysis');

  const stored = await repos.emails.getById(email.id);
  assert.equal(stored?.state, 'understand_failed');

  const events = await repos.audit.listByEmail(email.id);
  assert.ok(events.some((event) => event.outcome === 'failed'));
  await close();
});

test('a failed email can be retried and then succeeds', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  await understandEmail(email, { repos, provider: scriptedProvider(() => new Error('down')), logger: quiet });
  const failed = (await repos.emails.getById(email.id)) as EmailRecord;
  assert.equal(failed.state, 'understand_failed');

  assertUnderstandable(failed); // must not throw — retry is allowed
  const retried = await understandEmail(failed, { repos, provider: demoProvider(), logger: quiet });
  assert.equal(retried.state, 'resolving');
  await close();
});

test('malformed output is repaired once, and the repair is used', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const provider = scriptedProvider((_request, call) =>
    call === 1 ? response({ category: 'not_a_category', confidence: 9 }) : response(goodOutput()),
  );

  const outcome = await understandEmail(email, { repos, provider, logger: quiet });
  assert.equal(outcome.state, 'resolving');
  assert.equal(outcome.analysis?.attempt, 2, 'the second attempt should be the one recorded');
  await close();
});

test('the repair prompt is fed the problems from the first attempt', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  let repairPrompt = '';
  const provider = scriptedProvider((request, call) => {
    if (call === 1) return response({ category: 'nope' });
    repairPrompt = request.messages[request.messages.length - 1]?.content ?? '';
    return response(goodOutput());
  });

  await understandEmail(email, { repos, provider, logger: quiet });
  assert.match(repairPrompt, /could not be accepted/);
  assert.match(repairPrompt, /category/);
  await close();
});

test('output that stays malformed after the retry goes to review, never half-parsed', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const provider = scriptedProvider(() => response({ category: 'nonsense', confidence: 'high' }));
  const outcome = await understandEmail(email, { repos, provider, logger: quiet });

  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'no_valid_plan');
  assert.equal(outcome.understanding, null);
  assert.equal(await repos.analyses.count(), 0);
  assert.ok(outcome.validation.problems.length > 0);
  await close();
});

test('a persistence failure surfaces instead of being swallowed', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  // Analysis persistence is not optional the way a history read is: if the
  // reading cannot be stored, the caller must find out rather than receive an
  // outcome that implies it was.
  const broken: Repositories = {
    ...repos,
    analyses: {
      ...repos.analyses,
      create: async () => {
        throw new Error('disk is full');
      },
    } as Repositories['analyses'],
  };

  const err = await rejects(() => understandEmail(email, { repos: broken, provider: demoProvider(), logger: quiet }));
  assert.match(err.message, /disk is full/);
  await close();
});

test('a low-confidence reading is routed to a person', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const provider = scriptedProvider(() => response(goodOutput({ confidence: 0.3 })));
  const outcome = await understandEmail(email, { repos, provider, logger: quiet });

  assert.equal(outcome.understanding?.confidenceBand, 'low');
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'low_confidence');
  await close();
});

test('an insufficient-information flag routes to a person even at high confidence', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  const provider = scriptedProvider(() =>
    response(
      goodOutput({
        confidence: 0.97,
        flags: { insufficientInformation: true, ambiguousIntent: false, possibleInjection: false },
      }),
    ),
  );
  const outcome = await understandEmail(email, { repos, provider, logger: quiet });

  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'insufficient_information');
  await close();
});

test('understanding an email mid-flight through another stage is refused', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  await repos.emails.setState(email.id, 'executing');
  const executing = (await repos.emails.getById(email.id)) as EmailRecord;
  assert.throws(() => assertUnderstandable(executing), /cannot be analysed/);
  await close();
});

// ============================================================== persistence

test('an analysis keeps model output, effective understanding, validation and security apart', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e02');
  await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  const analysis = await repos.analyses.getLatestForEmail(email.id);
  assert.ok(analysis);
  assert.equal(analysis.promptVersion, 'understand.v1');
  assert.equal(analysis.model, 'mock');
  assert.ok(analysis.modelOutput);
  assert.ok(analysis.validation);
  assert.ok(analysis.security.sanitisation);
  assert.ok(analysis.security.injection);
  assert.equal(analysis.understanding.questionAsked, 'What would the process look like working with you?');
  await close();
});

test('re-analysing appends a new reading and never rewrites the old one', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');

  await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });
  const after = (await repos.emails.getById(email.id)) as EmailRecord;
  await understandEmail(after, { repos, provider: demoProvider(), logger: quiet });

  const all = await repos.analyses.listForEmail(email.id);
  assert.equal(all.length, 2, 'history is appended, not replaced');
  assert.equal((await repos.analyses.getLatestForEmail(email.id))?.id, all[0]?.id);
  await close();
});

test('the original email is never modified by understanding it', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const before = await emailFor(repos, 'demo-e10');

  await understandEmail(before, { repos, provider: demoProvider(), logger: quiet });
  const after = (await repos.emails.getById(before.id)) as EmailRecord;

  assert.equal(after.bodyText, before.bodyText, 'the stored message must survive analysis unchanged');
  assert.equal(after.subject, before.subject);
  assert.equal(after.receivedAt, before.receivedAt);
  assert.equal(after.correlationId, before.correlationId);
  await close();
});

test('re-analysing is deterministic with the mock provider', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e03');
  const provider = demoProvider();

  const first = await understandEmail(email, { repos, provider, logger: quiet });
  const second = await understandEmail(
    (await repos.emails.getById(email.id)) as EmailRecord,
    { repos, provider, logger: quiet },
  );

  assert.deepEqual(second.understanding, first.understanding);
  assert.deepEqual(second.validation.droppedFields, first.validation.droppedFields);
  assert.equal(second.state, first.state);
  await close();
});

test('every stage transition produces an audit event with an actor', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');
  await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  const events = await repos.audit.listByEmail(email.id);
  const types = events.map((event) => event.eventType);

  assert.ok(types.includes('email_received'));
  assert.ok(types.includes('classification_recorded'));
  assert.ok(types.includes('extraction_recorded'));
  assert.ok(types.includes('state_changed'));
  for (const event of events) {
    assert.ok(['system', 'ai', 'human'].includes(event.actor));
    assert.ok(event.summary.length > 0);
  }
  await close();
});

test('the audit payload records a digest of the input, not the email text', async () => {
  const { repos, close } = await createTestContext();
  await ingestDemo(repos);
  const email = await emailFor(repos, 'demo-e01');
  await understandEmail(email, { repos, provider: demoProvider(), logger: quiet });

  const events = await repos.audit.listByEmail(email.id);
  const classification = events.find((event) => event.eventType === 'classification_recorded');
  assert.ok(classification);
  assert.match(String(classification.payload.inputDigest), /^sha256:[0-9a-f]{64}$/);

  const serialised = JSON.stringify(events);
  assert.doesNotMatch(serialised, /We run a small Shopify store/, 'the body must not be copied into the audit log');
  await close();
});
