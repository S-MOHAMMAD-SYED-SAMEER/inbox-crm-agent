import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, DEMO_DATA_DIR, MIGRATIONS_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { understandEmail } from '../src/agent/understand/understand.ts';
import { resolveEmail, resolveMatchByHuman, assertResolvable, enrichCandidateLabels } from '../src/agent/resolve/resolve.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import {
  handleGetEmail,
  handleIngest,
  handleListEmails,
  handleResolveEmail,
  handleResolvePending,
  handleResolveMatch,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import { runResolveEvaluation, resolveThresholdFailures } from '../src/eval/resolve/runner.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';

// M2 integration tests: the real resolver against a real schema and the real
// seeded CRM. Only the model call is replaced — resolution makes none at all,
// so the code under test here is exactly what runs in production.

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

/** Seeds the CRM, ingests the demo emails, and runs UNDERSTAND over all of them. */
async function pipelineToUnderstand(repos: Repositories): Promise<void> {
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
}

async function emailFor(repos: Repositories, providerMessageId: string): Promise<EmailRecord> {
  const email = await repos.emails.findByProviderMessageId('demo', providerMessageId);
  assert.ok(email, `fixture ${providerMessageId} missing`);
  return email;
}

// ============================================================ end-to-end

test('an existing customer matches on both contact and company', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const outcome = await resolveEmail(await emailFor(repos, 'demo-e05'), { repos, logger: quiet });

  assert.equal(outcome.contact.verdict, 'MATCH');
  assert.equal(outcome.contact.candidates[0]?.method, 'exact_email');
  assert.equal(outcome.company.verdict, 'MATCH');
  assert.equal(outcome.company.candidates[0]?.method, 'exact_domain');
  assert.ok(outcome.contact.selectedEntityId);
  await close();
});

test('a new contact at an existing company matches the company only', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const outcome = await resolveEmail(await emailFor(repos, 'demo-e03'), { repos, logger: quiet });
  const company = await enrichCandidateLabels(repos, outcome.company);

  assert.equal(outcome.contact.verdict, 'NO_MATCH', 'Priya must not be matched to her colleague Anil');
  assert.equal(company.verdict, 'MATCH');
  assert.equal(company.candidates[0]?.label, 'Vantage Consulting');
  await close();
});

test('an unknown sender matches nothing at all', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const outcome = await resolveEmail(await emailFor(repos, 'demo-e01'), { repos, logger: quiet });

  assert.equal(outcome.contact.verdict, 'NO_MATCH');
  assert.equal(outcome.company.verdict, 'NO_MATCH');
  assert.equal(outcome.contact.candidates.length, 0);
  assert.equal(outcome.state, 'deciding');
  await close();
});

test('spam does not acquire a CRM identity', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const outcome = await resolveEmail(await emailFor(repos, 'demo-e09'), { repos, logger: quiet });
  assert.equal(outcome.contact.verdict, 'NO_MATCH');
  assert.equal(outcome.company.verdict, 'NO_MATCH');
  await close();
});

// ================================================= E-04 Harborview conflict

test('E-04: the Harborview conflict is detected, not guessed', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  assert.equal(email.fromEmail, 'mark@harborview-group.com');

  const outcome = await resolveEmail(email, { repos, logger: quiet });
  const company = await enrichCandidateLabels(repos, outcome.company);

  assert.equal(company.verdict, 'MATCH_CONFLICT');
  assert.equal(company.outcome, 'conflict');
  assert.equal(company.selectedEntityId, null, 'a conflict must link nothing');
  assert.equal(company.candidates.length, 2);
  assert.deepEqual(
    company.candidates.map((c) => c.label).sort(),
    ['Harborview Digital', 'Harborview Media Ltd'],
  );
  assert.equal(company.candidates[0]?.score, company.candidates[1]?.score, 'the two are equally plausible');

  // The email itself is routed to a person with a machine-readable reason.
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'match_conflict');

  const events = await repos.audit.listByEmail(email.id);
  assert.ok(events.some((e) => e.eventType === 'match_conflict_raised'));
  await close();
});

test('E-04 writes nothing to the CRM while unresolved', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const before = { companies: await repos.companies.count(), contacts: await repos.contacts.count() };
  await resolveEmail(await emailFor(repos, 'demo-e04'), { repos, logger: quiet });

  assert.equal(await repos.companies.count(), before.companies);
  assert.equal(await repos.contacts.count(), before.contacts);
  await close();
});

// =============================================== contact/company conflict

function analysisFixture(fields: Record<string, string>): Record<string, unknown> {
  const names = ['contactName','contactEmail','contactPhone','jobTitle','companyName','companyDomain',
    'serviceInterest','requirementSummary','budget','timeline','urgencyCues'];
  return {
    category: 'follow_up', intent: 'Says they moved.', priority: 'medium',
    priorityReason: 'A contact update.', confidence: 0.9,
    flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: false },
    extracted: Object.fromEntries(
      names.map((f) => [
        f,
        fields[f] === undefined
          ? { value: null, confidence: 0, sourceSpan: null }
          : { value: fields[f], confidence: 0.9, sourceSpan: fields[f] },
      ]),
    ),
    questionAsked: null, summary: 'Contact says they moved company.',
  };
}

/** Ingests one hand-built email plus its canned analysis, and runs UNDERSTAND. */
async function understandOne(
  repos: Repositories,
  message: { id: string; fromName: string; fromEmail: string; body: string },
  analysis: Record<string, unknown>,
): Promise<EmailRecord> {
  const source = createDemoEmailSource({
    fixtures: [
      {
        provider: 'demo', providerMessageId: message.id, threadId: null,
        fromName: message.fromName, fromEmail: message.fromEmail,
        toEmail: 'hello@x.test', cc: null, subject: 'Moving companies',
        bodyText: message.body, headers: {}, receivedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  });
  const { ingested } = await ingestEmails({ repos, source, logger: quiet });
  const email = ingested[0] as EmailRecord;

  const provider = createMockLlmProvider();
  provider.register(message.id, { toolInput: analysis });
  await understandEmail(email, { repos, provider, logger: quiet });

  return (await repos.emails.getById(email.id)) as EmailRecord;
}

test('two equally exact company signals conflict rather than picking one', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  // The sender's domain says Solstice Retail; the body says Harborview. Both
  // are exact domain matches, so neither can win.
  const email = await understandOne(
    repos,
    { id: 'tied-domains', fromName: 'Marcus Bell', fromEmail: 'marcus@solsticeretail.com',
      body: 'I am at Harborview Digital now, harborview.io.' },
    analysisFixture({ contactName: 'Marcus Bell', companyDomain: 'harborview.io' }),
  );

  const outcome = await resolveEmail(email, { repos, logger: quiet });

  assert.equal(outcome.company.verdict, 'MATCH_CONFLICT');
  assert.equal(outcome.company.selectedEntityId, null);
  assert.equal(outcome.company.candidates.length, 2);
  assert.equal(outcome.contact.verdict, 'MATCH', 'the sender address is still unambiguous');
  assert.equal(outcome.state, 'needs_review');
  assert.equal(outcome.reviewReason, 'match_conflict');
  await close();
});

test('12. a matched contact whose company differs from the email company is a conflict', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  // A contact on a personal address, filed under Solstice Retail, writing about
  // Harborview. Both signals are individually confident and they disagree —
  // which must not add up to a confident answer.
  const solstice = await repos.companies.findByDomain('solsticeretail.com');
  assert.ok(solstice);
  await repos.contacts.create({
    fullName: 'Marcus Bell', email: 'marcus@personal.example', companyId: solstice.id, source: 'seed',
  });

  const email = await understandOne(
    repos,
    { id: 'cross-conflict', fromName: 'Marcus Bell', fromEmail: 'marcus@personal.example',
      body: 'I am at Harborview Digital now, harborview.io.' },
    analysisFixture({ contactName: 'Marcus Bell', companyDomain: 'harborview.io' }),
  );

  const outcome = await resolveEmail(email, { repos, logger: quiet });

  assert.equal(outcome.contact.verdict, 'MATCH_CONFLICT');
  assert.equal(outcome.company.verdict, 'MATCH_CONFLICT');
  assert.equal(outcome.contact.selectedEntityId, null, 'neither side may be trusted when they disagree');
  assert.equal(outcome.company.selectedEntityId, null);
  assert.equal(outcome.state, 'needs_review');
  assert.match(outcome.contact.reason, /different company/i);
  await close();
});

// ================================================== persistence + identity

test('a resolution run persists every candidate with its score, method and evidence', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  await resolveEmail(email, { repos, logger: quiet });

  const rows = await repos.entityMatches.getLatestRun(email.id, 'company');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.outcome, 'conflict');
    assert.equal(row.selected, false);
    assert.ok(row.entityId);
    assert.equal(row.score, 0.65);
    assert.equal(row.method, 'distinctive_token');
    assert.ok(row.evidence.length > 10, 'each candidate carries its own evidence');
    assert.ok(row.reason.length > 20, 'each row carries the run verdict');
    assert.ok(row.analysisId, 'the analysis it was based on is referenced');
    assert.ok(row.resolutionRun);
  }
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
  await close();
});

test('the contact and company runs are stored separately, not mixed', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  await resolveEmail(email, { repos, logger: quiet });

  const contactRows = await repos.entityMatches.getLatestRun(email.id, 'contact');
  const companyRows = await repos.entityMatches.getLatestRun(email.id, 'company');

  assert.ok(contactRows.every((r) => r.entityType === 'contact'));
  assert.ok(companyRows.every((r) => r.entityType === 'company'));
  assert.equal(contactRows[0]?.outcome, 'propose_create');
  assert.equal(companyRows[0]?.outcome, 'conflict');
  await close();
});

test('a NO_MATCH still records a row, so "looked and found nothing" is distinguishable from "never ran"', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e01');
  await resolveEmail(email, { repos, logger: quiet });

  const rows = await repos.entityMatches.getLatestRun(email.id, 'company');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.entityId, null);
  assert.equal(rows[0]?.outcome, 'propose_create');
  await close();
});

test('the original email and its analysis are untouched by resolution', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const before = await emailFor(repos, 'demo-e05');
  const analysisBefore = await repos.analyses.getLatestForEmail(before.id);

  await resolveEmail(before, { repos, logger: quiet });

  const after = (await repos.emails.getById(before.id)) as EmailRecord;
  const analysisAfter = await repos.analyses.getLatestForEmail(before.id);

  assert.equal(after.bodyText, before.bodyText);
  assert.equal(after.subject, before.subject);
  assert.equal(after.correlationId, before.correlationId);
  assert.deepEqual(analysisAfter?.understanding, analysisBefore?.understanding);
  assert.equal(analysisAfter?.id, analysisBefore?.id, 'no new analysis is written');
  await close();
});

test('re-resolving is deterministic and appends a run rather than editing one', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  const first = await resolveEmail(email, { repos, logger: quiet });

  const again = (await repos.emails.getById(email.id)) as EmailRecord;
  assertResolvable({ ...again, state: 'resolving' });
  const second = await resolveEmail({ ...again, state: 'resolving' }, { repos, logger: quiet });

  assert.equal(second.company.verdict, first.company.verdict);
  assert.deepEqual(
    second.company.candidates.map((c) => [c.entityId, c.score]),
    first.company.candidates.map((c) => [c.entityId, c.score]),
  );
  assert.notEqual(second.resolutionRun, first.resolutionRun);

  const all = await repos.entityMatches.listForEmail(email.id);
  assert.ok(all.length > 4, 'both runs are retained');
  await close();
});

// ================================================== workflow transitions

test('resolution moves a resolved email to deciding, ready for M3', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const outcome = await resolveEmail(await emailFor(repos, 'demo-e05'), { repos, logger: quiet });
  assert.equal(outcome.state, 'deciding');
  assert.equal(outcome.reviewReason, null);
  assert.equal(((await repos.emails.getById(outcome.email.id)) as EmailRecord).state, 'deciding');
  await close();
});

test('an email that never reached resolution cannot be resolved', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  // E-10 is held at needs_review by the injection detector in M1.
  const injected = await emailFor(repos, 'demo-e10');
  assert.equal(injected.state, 'needs_review');
  assert.throws(() => assertResolvable(injected), /cannot be matched/);
  await close();
});

test('a human resolving a conflict advances the email and records who decided', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  const conflicted = await resolveEmail(email, { repos, logger: quiet });
  const chosen = conflicted.company.candidates[0]?.entityId as string;

  const settled = await resolveMatchByHuman(
    (await repos.emails.getById(email.id)) as EmailRecord,
    { entityType: 'company', entityId: chosen, decidedBy: 'sameer' },
    { repos, logger: quiet },
  );

  assert.equal(settled.company.verdict, 'MATCH');
  assert.equal(settled.company.outcome, 'human_selected');
  assert.equal(settled.company.selectedEntityId, chosen);
  assert.equal(settled.state, 'deciding');
  assert.equal(settled.reviewReason, null);

  const events = await repos.audit.listByEmail(email.id);
  const human = events.filter((e) => e.actor === 'human');
  assert.ok(human.some((e) => e.eventType === 'match_resolved_by_human'));
  assert.equal(human[0]?.actorId, 'sameer');

  // The machine's original verdict is still there — the diff is the signal.
  const all = await repos.entityMatches.listForEmail(email.id);
  assert.ok(all.some((r) => r.outcome === 'conflict'), 'the original conflict is not rewritten');
  await close();
});

test('a human can declare a conflicted match a new record instead', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e04');
  await resolveEmail(email, { repos, logger: quiet });

  const settled = await resolveMatchByHuman(
    (await repos.emails.getById(email.id)) as EmailRecord,
    { entityType: 'company', entityId: null, decidedBy: 'sameer' },
    { repos, logger: quiet },
  );

  assert.equal(settled.company.verdict, 'NO_MATCH');
  assert.equal(settled.company.selectedEntityId, null);
  assert.equal(settled.state, 'deciding');
  // Still no CRM write: choosing "new" records the intent for M3, nothing more.
  assert.equal(await repos.companies.count(), 6);
  await close();
});

test('resolving a match on an email that is not conflicted is refused', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const email = await emailFor(repos, 'demo-e05');
  await resolveEmail(email, { repos, logger: quiet });

  const settledEmail = (await repos.emails.getById(email.id)) as EmailRecord;
  const err = await rejects(() =>
    resolveMatchByHuman(
      settledEmail,
      { entityType: 'company', entityId: 'anything', decidedBy: 'sameer' },
      { repos, logger: quiet },
    ),
  );
  assert.match(err.message, /not waiting on a CRM match decision/);
  await close();
});

// ================================================================ security

test('resolution never mutates the CRM, across the whole dataset', async () => {
  const { repos, close } = await createTestContext();
  await pipelineToUnderstand(repos);

  const before = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
    notes: await repos.notes.count(),
  };

  for (const email of await repos.emails.list({ state: 'resolving', limit: 50 })) {
    await resolveEmail(email, { repos, logger: quiet });
  }

  assert.deepEqual(
    {
      contacts: await repos.contacts.count(),
      companies: await repos.companies.count(),
      deals: await repos.deals.count(),
      tasks: await repos.tasks.count(),
      activities: await repos.activities.count(),
      notes: await repos.notes.count(),
    },
    before,
    'entity resolution reads the CRM and must never write to it',
  );

  const outbox = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_messages');
  const decisions = await repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM decisions');
  assert.equal(Number(outbox[0]?.n), 0);
  assert.equal(Number(decisions[0]?.n), 0);
  await close();
});

// ==================================================== repository behaviour

test('candidate generation finds contacts by email domain, anchored so it cannot over-match', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  const solstice = await repos.contacts.listByEmailDomain('solsticeretail.com');
  assert.equal(solstice.length, 2);

  // `notsolsticeretail.com` must not be pulled in by a bare LIKE.
  await repos.contacts.create({
    fullName: 'Impostor', email: 'x@notsolsticeretail.com', source: 'human',
  });
  assert.equal((await repos.contacts.listByEmailDomain('solsticeretail.com')).length, 2);
  await close();
});

test('candidate generation finds companies by name token and escapes wildcards', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  const harborview = await repos.companies.listByNameTokens(['harborview']);
  assert.equal(harborview.length, 2);

  assert.equal((await repos.companies.listByNameTokens([])).length, 0);
  assert.equal((await repos.companies.listByNameTokens(['%'])).length, 0, 'a bare wildcard matches nothing');
  await close();
});

// ================================================================== API

test('the resolve endpoints move emails through the pipeline and expose the verdicts', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);

  await handleIngest(d, {});
  await handleUnderstandPending(d, {});

  const batch = await handleResolvePending(d, {});
  assert.equal(batch.body.resolved, 8, 'E-08 and E-10 are held at needs_review by M1');
  assert.equal(batch.body.conflicts, 1);
  assert.equal(batch.body.failed, 0);

  const listed = await handleListEmails(d, {});
  const e04 = listed.body.emails.find((e) => e.subject.includes('Harborview'));
  assert.equal(e04?.resolution?.company, 'MATCH_CONFLICT');
  assert.equal(e04?.state, 'needs_review');
  await close();
});

test('the detail payload exposes candidates with real names, and reports DECIDE as unrun', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await handleIngest(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});

  const email = await emailFor(repos, 'demo-e04');
  const detail = await handleGetEmail(d, email.id);

  assert.equal(detail.body.stages.resolve, 'conflict');
  // CONTRACT CHANGE (M3): DECIDE exists now, so it reports 'pending' rather
  // than 'not_implemented'. A conflicted email never reaches it either way.
  assert.equal(detail.body.stages.decide, 'pending');
  assert.ok(detail.body.resolution);
  assert.deepEqual(
    detail.body.resolution.company.candidates.map((c) => c.label).sort(),
    ['Harborview Digital', 'Harborview Media Ltd'],
  );
  await close();
});

test('the detail payload has no resolution before resolution has run', async () => {
  const { repos, close } = await createTestContext();
  const d = deps(repos);
  await handleIngest(d, {});

  const email = await emailFor(repos, 'demo-e01');
  const detail = await handleGetEmail(d, email.id);
  assert.equal(detail.body.resolution, null, 'never a fabricated verdict');
  assert.equal(detail.body.stages.resolve, 'pending');
  await close();
});

test('the resolve-match endpoint validates its input and records the operator', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  const d = deps(repos);
  await handleIngest(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});

  const email = await emailFor(repos, 'demo-e04');

  const badType = await rejects(() => handleResolveMatch(d, email.id, { entityType: 'deal', entityId: 'x' }, 'op'));
  assert.equal((badType as { code?: string }).code, 'VALIDATION_ERROR');

  const missingId = await rejects(() => handleResolveMatch(d, email.id, { entityType: 'company' }, 'op'));
  assert.equal((missingId as { code?: string }).code, 'VALIDATION_ERROR');

  const unknownId = await rejects(() =>
    handleResolveMatch(d, email.id, { entityType: 'company', entityId: 'no-such-company' }, 'op'),
  );
  assert.equal((unknownId as { code?: string }).code, 'VALIDATION_ERROR');

  const detail = await handleGetEmail(d, email.id);
  const candidateId = detail.body.resolution?.company.candidates[0]?.entityId as string;
  const settled = await handleResolveMatch(d, email.id, { entityType: 'company', entityId: candidateId }, 'sameer');
  assert.equal(settled.body.email.state, 'deciding');
  await close();
});

test('resolving an email that does not exist is a 404', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => handleResolveEmail(deps(repos), 'no-such-id'));
  assert.equal((err as { code?: string }).code, 'NOT_FOUND');
  await close();
});

// ============================================================ evaluation

test('the M2 evaluation passes every threshold, deterministically', async () => {
  const options = {
    datasetPath: path.join(MIGRATIONS_DIR, '..', 'eval', 'resolve.dataset.json'),
    demoDataDir: DEMO_DATA_DIR,
    migrationsDir: MIGRATIONS_DIR,
  };

  const first = await runResolveEvaluation(options);
  assert.equal(first.metrics.passed, first.metrics.cases);
  assert.deepEqual(resolveThresholdFailures(first.metrics), []);
  assert.equal(first.metrics.crmWrites, 0);
  assert.equal(first.metrics.conflictsLinked, 0);
  assert.ok(first.metrics.conflictsDetected >= 1);

  const second = await runResolveEvaluation(options);
  assert.deepEqual(second.metrics, first.metrics, 'same inputs must give the same numbers');
});
