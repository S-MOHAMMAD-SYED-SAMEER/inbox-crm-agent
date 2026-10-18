import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, startAuthenticatedServer, rejects, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/adapters/llm/types.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { understandEmail } from '../src/agent/understand/understand.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { emptyExtraction } from '../src/domain/understanding.ts';
import {
  handleDecidePending,
  handleGetEmail,
  handleListEmails,
  handleResolvePending,
  handleReviewEmail,
  handleUnderstandPending,
  reviewActionsFor,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';
import type { EmailRecord } from '../src/domain/email.ts';
import { AppError } from '../src/lib/errors.ts';

// UI fixes U-2, U-3 and U-4: what a person can do with an email handed to them, a summary that still mentions a discarded
// value, and the model's reading kept apart from what the code changed. No model call: the scripted provider and the mock.

const quiet = createLogger('test', { level: 'error' });

async function pipelineUpToUnderstand() {
  const ctx = await createTestContext();
  await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  const source = createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') });
  await ingestEmails({ repos: ctx.repos, source, logger: quiet });
  const deps = { repos: ctx.repos, source, provider, logger: quiet };
  await handleUnderstandPending(deps);
  return { ...ctx, deps, provider };
}

async function emailOf(repos: Repositories, id: string): Promise<EmailRecord> {
  const email = await repos.emails.findByProviderMessageId('demo', id);
  assert.ok(email, `${id} was not ingested`);
  return email;
}

async function crmCounts(repos: Repositories) {
  return {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };
}

// =================================================================== U-2: the review action

test('which actions an email offers: archive for anything handed to a person, continue only for an ambiguous reading', async () => {
  assert.deepEqual(reviewActionsFor({ state: 'needs_review', reviewReason: 'ambiguous_intent' }), ['archive', 'continue']);
  assert.deepEqual(reviewActionsFor({ state: 'needs_review', reviewReason: 'possible_injection' }), ['archive']);
  assert.deepEqual(reviewActionsFor({ state: 'needs_review', reviewReason: 'match_conflict' }), ['archive']);
  assert.deepEqual(reviewActionsFor({ state: 'awaiting_approval', reviewReason: null }), []);
  assert.deepEqual(reviewActionsFor({ state: 'received', reviewReason: null }), []);
});

test('"continue" on an ambiguous email records the check, matches and plans as normal, and ends waiting for approval', async () => {
  const f = await pipelineUpToUnderstand();
  const e08 = await emailOf(f.repos, 'demo-e08');
  assert.equal(e08.state, 'needs_review');
  assert.equal(e08.reviewReason, 'ambiguous_intent');
  const before = await crmCounts(f.repos);

  const { body } = await handleReviewEmail(f.deps, e08.id, { action: 'continue' }, 'operator');

  assert.equal(body.email.state, 'awaiting_approval', 'the plan still needs a person');
  assert.equal(body.decision?.plan.requiresApproval, true);
  assert.ok(body.decision?.plan.approvalReasons.some((r) => r.code === 'ambiguous_intent'), 'approval is required because the reading is still ambiguous');
  assert.deepEqual(body.decision?.plan.actions.map((a) => a.type), ['log_activity', 'create_task']);
  assert.ok(body.decision?.plan.ruleTrace.some((t) => t.rule === 'R-20' && t.fired), 'R-20 is in the trace');
  assert.ok(body.decision?.plan.ruleTrace.some((t) => t.rule === 'R-18' && !t.fired));
  assert.equal(body.decision?.plan.draft, null, 'nothing is drafted and so nothing could be sent');
  assert.deepEqual(await crmCounts(f.repos), before, 'planning writes nothing to the CRM');

  const checked = body.audit.find((event) => event.eventType === 'human_review_recorded');
  assert.ok(checked, 'the check is in the audit log');
  assert.equal(checked.actor, 'human');
  assert.equal(checked.actorId, 'operator');
  assert.match(checked.summary, /operator checked this email/);
  // The check comes before the match and the plan.
  const order = body.audit.map((event) => event.eventType);
  assert.ok(order.indexOf('human_review_recorded') < order.indexOf('plan_created'));
  await f.close();
});

test('"archive" ends the email with no CRM change, and says who did it', async () => {
  const f = await pipelineUpToUnderstand();
  const e08 = await emailOf(f.repos, 'demo-e08');
  const before = await crmCounts(f.repos);

  const { body } = await handleReviewEmail(f.deps, e08.id, { action: 'archive' }, 'operator');
  assert.equal(body.email.state, 'archived');
  assert.equal(body.decision, null, 'no plan was made');
  assert.deepEqual(await crmCounts(f.repos), before, 'archiving writes no CRM records');
  const entry = body.audit.find((event) => event.eventType === 'human_review_recorded');
  assert.equal(entry?.actor, 'human');
  assert.equal(entry?.actorId, 'operator');
  assert.match(entry?.summary ?? '', /archived this email\. No CRM record was created or changed/);
  await f.close();
});

test('"continue" on a possible injection is refused by the server (403), and the email stays where it was', async () => {
  const f = await pipelineUpToUnderstand();
  const e10 = await emailOf(f.repos, 'demo-e10');
  assert.equal(e10.reviewReason, 'possible_injection');

  const error = await rejects(() => handleReviewEmail(f.deps, e10.id, { action: 'continue' }, 'operator'));
  assert.ok(error instanceof AppError);
  assert.equal((error as AppError).code, 'FORBIDDEN');
  assert.equal((error as AppError).status, 403);
  assert.equal((await emailOf(f.repos, 'demo-e10')).state, 'needs_review');
  assert.equal((await f.repos.audit.listByEmail(e10.id)).some((event) => event.eventType === 'human_review_recorded'), false, 'a refused action leaves no check on the record');

  // The same refusal over HTTP, from a signed-in session: enforced in the server, whatever the screen shows.
  const server = await startAuthenticatedServer(f.db);
  try {
    const headers = { 'content-type': 'application/json', cookie: server.cookie, 'x-csrf-token': server.csrf };
    const refused = await fetch(`${server.url}/api/emails/${e10.id}/review`, { method: 'POST', headers, body: JSON.stringify({ action: 'continue' }) });
    assert.equal(refused.status, 403);
    assert.equal((await emailOf(f.repos, 'demo-e10')).state, 'needs_review');
    const archived = await fetch(`${server.url}/api/emails/${e10.id}/review`, { method: 'POST', headers, body: JSON.stringify({ action: 'archive' }) });
    assert.equal(archived.status, 200);
    const detail = (await archived.json()) as { email: { state: string }; audit: Array<{ eventType: string; actor: string; actorId: string }> };
    assert.equal(detail.email.state, 'archived');
    const entry = detail.audit.find((event) => event.eventType === 'human_review_recorded');
    assert.equal(entry?.actor, 'human');
    assert.equal(entry?.actorId, 'operator', 'the actor is the signed-in operator, not something the request said');
    const noBody = await fetch(`${server.url}/api/emails/${e10.id}/review`, { method: 'POST', headers, body: JSON.stringify({ action: 'delete' }) });
    assert.equal(noBody.status, 400);
  } finally {
    await server.stop();
  }
  await f.close();
});

test('the review action only applies to an email that is waiting for a person', async () => {
  const f = await pipelineUpToUnderstand();
  const e01 = await emailOf(f.repos, 'demo-e01');
  assert.equal(e01.state, 'resolving');
  const error = await rejects(() => handleReviewEmail(f.deps, e01.id, { action: 'archive' }, 'operator'));
  assert.equal((error as AppError).status, 409);
  assert.equal((await emailOf(f.repos, 'demo-e01')).state, 'resolving');
  await f.close();
});

test('R-20 never applies without the person\'s check: an ambiguous email left alone still gets no plan', async () => {
  const f = await pipelineUpToUnderstand();
  // E-08 stays in needs_review, and nothing the batch stages do touches it.
  await handleResolvePending(f.deps);
  await handleDecidePending(f.deps);
  const e08 = await emailOf(f.repos, 'demo-e08');
  assert.equal(e08.state, 'needs_review');
  assert.equal((await handleGetEmail(f.deps, e08.id)).body.decision, null);
  await f.close();
});

// =========================================== U-3: a summary that mentions a discarded value

function scripted(output: Record<string, unknown>): LlmProvider {
  return {
    name: 'mock',
    configured: true,
    async complete(_request: LlmRequest): Promise<LlmResponse> {
      return { toolInput: output, model: 'mock', latencyMs: 0, stopReason: 'tool_use' } as LlmResponse;
    },
  };
}

async function ingestCustom(repos: Repositories, id: string, fromEmail: string, bodyText: string) {
  const source = createDemoEmailSource({
    fixtures: [
      {
        provider: 'demo',
        providerMessageId: id,
        threadId: null,
        fromName: 'Sarah Williams',
        fromEmail,
        toEmail: 'hello@us.invalid',
        cc: null,
        subject: 'Chatbot question',
        bodyText,
        headers: {},
        receivedAt: '2026-09-01T09:00:00.000Z',
      },
    ],
  });
  await ingestEmails({ repos, source, logger: quiet });
  const email = await repos.emails.findByProviderMessageId('demo', id);
  assert.ok(email);
  return { email };
}

function modelReply(overrides: Record<string, unknown>) {
  return {
    category: 'sales_inquiry',
    intent: 'Wants a chatbot.',
    priority: 'medium',
    priorityReason: 'A direct question.',
    confidence: 0.9,
    flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: false },
    extracted: { ...emptyExtraction() },
    questionAsked: null,
    summary: 'A chatbot enquiry.',
    ...overrides,
  };
}

test('a summary that names a discarded value is marked, the model text is kept as written, and the audit says so', async () => {
  const f = await createTestContext();
  const { email } = await ingestCustom(f.repos, 'leak-1', 'sarah@oakstudio.invalid', 'Hi,\n\nWe run a small online shop and want a chatbot for it.\n\nRegards,\nSarah');
  const reply = modelReply({
    summary: 'Sarah Williams from Acme Commerce asks about adding an AI chatbot.',
    extracted: {
      ...emptyExtraction(),
      contactName: { value: 'Sarah Williams', confidence: 0.9, sourceSpan: 'Sarah Williams' },
      // The email never names a company. The span is real text, the value is not written anywhere.
      companyName: { value: 'Acme Commerce', confidence: 0.8, sourceSpan: 'small online shop' },
    },
  });
  const deps = { repos: f.repos, provider: scripted(reply), logger: quiet };

  const outcome = await understandEmail(email, deps);
  assert.equal(outcome.understanding?.extracted.companyName.value, null, 'the company was discarded');
  assert.equal(outcome.understanding?.summary, 'Sarah Williams from Acme Commerce asks about adding an AI chatbot.', 'the model text is not rewritten');
  assert.deepEqual(outcome.validation.summaryMentions, [{ field: 'companyName', claimedValue: 'Acme Commerce', in: ['summary'] }]);

  const audit = (await f.repos.audit.listByEmail(email.id)).find((event) => event.eventType === 'summary_mentions_discarded_value');
  assert.ok(audit, 'there is an audit line');
  assert.equal(audit.actor, 'system');
  assert.match(audit.summary, /companyName: "Acme Commerce"/);

  const list = (await handleListEmails({ repos: f.repos })).body.emails.find((e) => e.id === email.id);
  assert.equal(list?.analysis?.summaryMentionsDiscarded, true, 'the Inbox row can show the marker');
  await f.close();
});

test('no marker when the summary does not name the discarded value, or when nothing was discarded', async () => {
  const f = await createTestContext();
  const { email } = await ingestCustom(f.repos, 'leak-2', 'sarah@oakstudio.invalid', 'Hi,\n\nWe run a small online shop and want a chatbot for it.\n\nRegards,\nSarah');
  const discardedButNotMentioned = modelReply({
    summary: 'Sarah Williams asks about adding an AI chatbot.',
    extracted: { ...emptyExtraction(), companyName: { value: 'Acme Commerce', confidence: 0.8, sourceSpan: 'small online shop' } },
  });
  const outcome = await understandEmail(email, { repos: f.repos, provider: scripted(discardedButNotMentioned), logger: quiet });
  assert.equal(outcome.validation.droppedFields.length, 1);
  assert.equal(outcome.validation.summaryMentions, undefined);
  assert.equal((await f.repos.audit.listByEmail(email.id)).some((e) => e.eventType === 'summary_mentions_discarded_value'), false);
  const list = (await handleListEmails({ repos: f.repos })).body.emails.find((e) => e.id === email.id);
  assert.equal(list?.analysis?.summaryMentionsDiscarded, false);
  await f.close();
});

test('a discarded value is also caught when it is the intent that names it, case and spacing aside', async () => {
  const f = await createTestContext();
  const { email } = await ingestCustom(f.repos, 'leak-3', 'sarah@oakstudio.invalid', 'Hi,\n\nWe run a small online shop and want a chatbot for it.\n\nRegards,\nSarah');
  const reply = modelReply({
    intent: 'A buyer at ACME   commerce wants a chatbot.',
    extracted: { ...emptyExtraction(), companyName: { value: 'Acme Commerce', confidence: 0.8, sourceSpan: 'small online shop' } },
  });
  const outcome = await understandEmail(email, { repos: f.repos, provider: scripted(reply), logger: quiet });
  assert.deepEqual(outcome.validation.summaryMentions, [{ field: 'companyName', claimedValue: 'Acme Commerce', in: ['intent'] }]);
  await f.close();
});

// ============================ U-4: what the model said, and what the code changed

test('when code changes the category the audit shows the model\'s reading under the model\'s name, then the code\'s change under the system\'s', async () => {
  const f = await createTestContext();
  const { email } = await ingestCustom(f.repos, 'override-1', 'mark@unknown-firm.invalid', 'Hi,\n\nFollowing on from the reporting work, could we set up a call?\n\nMark Doyle');
  const reply = modelReply({
    category: 'follow_up',
    confidence: 0.8,
    extracted: { ...emptyExtraction(), contactName: { value: 'Mark Doyle', confidence: 0.9, sourceSpan: 'Mark Doyle' } },
  });
  const outcome = await understandEmail(email, { repos: f.repos, provider: scripted(reply), logger: quiet });
  assert.equal(outcome.understanding?.category, 'ambiguous');

  const events = (await f.repos.audit.listByEmail(email.id)).filter((e) => e.eventType === 'classification_recorded' || e.eventType === 'category_changed_by_code');
  assert.equal(events.length, 2);
  const [ai, code] = events;
  assert.equal(ai?.eventType, 'classification_recorded');
  assert.equal(ai?.actor, 'ai');
  assert.equal(ai?.summary, 'Read as follow up (high confidence, 0.80).');
  assert.ok(ai);
  assert.equal((ai.payload as { category: string }).category, 'follow_up');
  assert.equal(code?.eventType, 'category_changed_by_code');
  assert.equal(code?.actor, 'system', 'a decision made by code is never logged under the AI');
  assert.match(code?.summary ?? '', /^Changed the category from follow up to ambiguous: .*no prior thread/);
  assert.ok(code);
  const change = code.payload as { from: string; to: string; rule: string };
  assert.deepEqual({ from: change.from, to: change.to, rule: change.rule }, { from: 'follow_up', to: 'ambiguous', rule: 'follow_up_without_context' });

  // The list says the model's category differed, which is what lets the confidence pill say so.
  const row = (await handleListEmails({ repos: f.repos })).body.emails.find((e) => e.id === email.id);
  assert.equal(row?.analysis?.category, 'ambiguous');
  assert.equal(row?.analysis?.modelCategory, 'follow_up');
  await f.close();
});

test('when the code did not change the category there is one classification entry, under the model, and no model category on the row', async () => {
  const f = await createTestContext();
  const { email } = await ingestCustom(f.repos, 'plain-1', 'sarah@acmecommerce.invalid', 'Hi,\n\nWe want a chatbot.\n\nSarah Williams');
  const reply = modelReply({ extracted: { ...emptyExtraction(), contactName: { value: 'Sarah Williams', confidence: 0.9, sourceSpan: 'Sarah Williams' } } });
  await understandEmail(email, { repos: f.repos, provider: scripted(reply), logger: quiet });
  const events = await f.repos.audit.listByEmail(email.id);
  assert.equal(events.filter((e) => e.eventType === 'category_changed_by_code').length, 0);
  const only = events.filter((e) => e.eventType === 'classification_recorded');
  assert.equal(only.length, 1);
  assert.equal(only[0]?.actor, 'ai');
  assert.equal((await handleListEmails({ repos: f.repos })).body.emails.find((e) => e.id === email.id)?.analysis?.modelCategory, null);
  await f.close();
});

// ================================================ U-5: NO_MATCH that creates nothing

test('the list says whether the plan creates a contact or a company, so a NO_MATCH that creates nothing can say "no match"', async () => {
  const f = await pipelineUpToUnderstand();
  await handleResolvePending(f.deps);
  await handleDecidePending(f.deps);
  const rows = (await handleListEmails({ repos: f.repos })).body.emails;
  const bySubject = (message: string) => rows.find((row) => row.subject === message);

  // E-09 (the cold pitch) is archived: the matcher found nothing, and the plan creates nothing.
  const pitch = rows.find((row) => row.fromEmail === 'outreach@rank-fast-seo.invalid');
  assert.equal(pitch?.resolution?.contact, 'NO_MATCH');
  assert.equal(pitch?.decision?.createsContact, false);
  assert.equal(pitch?.decision?.createsCompany, false);

  // E-01 (the hero lead) has no match and the plan creates both.
  const lead = bySubject('Shopify AI chatbot project');
  assert.equal(lead?.decision?.createsContact, true);
  assert.equal(lead?.decision?.createsCompany, true);
  await f.close();
});

// ====================================== U-7: audit rows say which email they belong to

test('the audit list names the email each row belongs to, by subject and sender, and never carries the body', async () => {
  const f = await pipelineUpToUnderstand();
  const { handleListAudit } = await import('../src/handlers/crm.ts');
  const { body } = await handleListAudit(f.repos, { limit: 200 });
  const rows = body.events.filter((event) => event.emailId !== null);
  assert.ok(rows.length > 10);
  for (const row of rows) {
    assert.ok(row.email, `${row.eventType} has no email`);
    assert.deepEqual(Object.keys(row.email).sort(), ['fromEmail', 'fromName', 'subject']);
  }
  const e08 = await emailOf(f.repos, 'demo-e08');
  const mine = rows.filter((row) => row.emailId === e08.id);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((row) => row.email?.subject === 'Following up' && row.email.fromEmail === 'j.contact@fastmail-example.invalid'));
  assert.equal(JSON.stringify(body).includes('Just following up on our conversation'), false, 'no email body in the list');
  await f.close();
});
