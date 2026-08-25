import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, rejects, startAuthenticatedServer, DEMO_DATA_DIR } from './helpers.ts';
import { createDemoEmailSource } from '../src/adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../src/adapters/llm/index.ts';
import { ingestEmails } from '../src/agent/ingest/ingest.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import {
  handleListAudit,
  handleListCompanies,
  handleListContacts,
  handleListDeals,
  handleListTasks,
} from '../src/handlers/crm.ts';
import {
  handleApprove,
  handleDecidePending,
  handleResolvePending,
  handleUnderstandPending,
} from '../src/handlers/emails.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// M6-C — the CRM read layer.
//
// These endpoints exist because the agent has been creating companies,
// contacts, deals and tasks since M4-A and none of it was browsable. Spec §11
// describes them; nothing had built them.
//
// The property worth attacking: they are READ-ONLY. The executor is the only
// thing permitted to write to the CRM, after an approval, through the closed
// action registry. A CRM endpoint that could write would be a second path into
// exactly the state the approval workflow protects — so the router exposes no
// verb but GET, and a test below asserts that against the source.

const quiet = createLogger('test', { level: 'error' });
const clock = createFixedClock('2026-06-01T02:00:00.000Z', 1000);

function deps(repos: Repositories) {
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, DEMO_DATA_DIR);
  return {
    repos,
    source: createDemoEmailSource({ filePath: path.join(DEMO_DATA_DIR, 'emails.json') }),
    provider,
    logger: quiet,
    clock,
  };
}

/** A seeded CRM with the hero plan applied, so agent-created rows exist. */
async function withAgentRecords(): Promise<Awaited<ReturnType<typeof createTestContext>>> {
  const ctx = await createTestContext({ idPrefix: 'm6c' });
  await seedDemoData(ctx.repos, readSeedFile(DEMO_DATA_DIR));

  const d = deps(ctx.repos);
  await ingestEmails(d, {});
  await handleUnderstandPending(d, {});
  await handleResolvePending(d, {});
  await handleDecidePending(d, {});

  const emails = await ctx.repos.emails.list({ limit: 50 });
  const hero = emails.find((row) => row.providerMessageId === 'demo-e01');
  assert.ok(hero);
  const decision = await ctx.repos.decisions.getCurrentForEmail(hero.id);
  assert.ok(decision);

  const approved = await handleApprove(d, decision.id, 'operator');
  assert.equal(approved.body.ok, true, approved.body.refusalMessage ?? '');

  return ctx;
}

// --- deals -------------------------------------------------------------------

test('deals list real records with their company and contact resolved', async () => {
  const ctx = await withAgentRecords();

  const { status, body } = await handleListDeals(ctx.repos);
  assert.equal(status, 200);
  assert.equal(body.total, 5, 'seed has 4 deals; the hero plan adds one');

  const created = body.deals.find((deal) => deal.title.includes('Acme'));
  assert.ok(created, 'the deal the agent just opened is not listed');
  assert.equal(created.source, 'agent', 'the agent-created deal is not identifiable');
  assert.equal(created.companyName, 'Acme Commerce', 'the company was not resolved to a name');
  assert.ok(created.contactName, 'the contact was not resolved to a name');
  assert.ok(created.contactEmail?.includes('@'));
  assert.ok(created.stage.length > 0);

  await ctx.close();
});

test('deals can be filtered by stage, and a bad stage is refused', async () => {
  const ctx = await withAgentRecords();

  const all = await handleListDeals(ctx.repos);
  const newLeads = await handleListDeals(ctx.repos, { stage: 'new_lead' });

  assert.ok(newLeads.body.deals.length > 0);
  assert.ok(newLeads.body.deals.every((deal) => deal.stage === 'new_lead'));
  assert.ok(newLeads.body.deals.length <= all.body.deals.length);

  const err = await rejects(() => handleListDeals(ctx.repos, { stage: 'not-a-stage' }));
  assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');

  await ctx.close();
});

test('a deal with no company or contact reports null rather than guessing', async () => {
  const ctx = await createTestContext({ idPrefix: 'orphan' });
  await ctx.repos.deals.create({
    title: 'Standalone deal',
    stage: 'new_lead',
    companyId: null,
    primaryContactId: null,
    serviceLine: null,
    amountMinor: null,
    currency: 'USD',
    requirementSummary: null,
    budgetNote: null,
    timelineNote: null,
    expectedCloseDate: null,
    source: 'human',
  });

  const { body } = await handleListDeals(ctx.repos);
  assert.equal(body.deals[0]?.companyName, null);
  assert.equal(body.deals[0]?.contactName, null);

  await ctx.close();
});

// --- contacts ----------------------------------------------------------------

test('contacts list real records with company and activity count', async () => {
  const ctx = await withAgentRecords();

  const { body } = await handleListContacts(ctx.repos);
  assert.equal(body.total, 10, 'seed has 9 contacts; the hero plan adds one');

  const created = body.contacts.find((contact) => contact.email.includes('acmecommerce'));
  assert.ok(created, 'the contact the agent just created is not listed');
  assert.equal(created.source, 'agent');
  assert.equal(created.companyName, 'Acme Commerce');
  assert.ok(created.fullName.length > 0);
  assert.ok(created.activityCount >= 1, 'the logged email did not count as activity');

  await ctx.close();
});

// --- companies ---------------------------------------------------------------

test('companies list with their contact and deal counts', async () => {
  const ctx = await withAgentRecords();

  const { body } = await handleListCompanies(ctx.repos);
  assert.equal(body.total, 7, 'seed has 6 companies; the hero plan adds one');

  const created = body.companies.find((company) => company.name === 'Acme Commerce');
  assert.ok(created);
  assert.equal(created.source, 'agent');
  assert.equal(created.contactCount, 1);
  assert.equal(created.dealCount, 1);

  await ctx.close();
});

// --- tasks -------------------------------------------------------------------

test('tasks list with their linked records resolved', async () => {
  const ctx = await withAgentRecords();

  const { body } = await handleListTasks(ctx.repos);
  // CONTRACT CHANGE (M6-E): 5 from the seed, one from the hero plan a person
  // approved, and one more from the support email — a tier-0 plan that needs no
  // approval and now runs as soon as it is decided rather than resting in
  // `deciding`. Both agent-created follow-ups are real records.
  assert.equal(body.total, 7, 'seed has 5 tasks; the approved hero plan and the unattended support plan add one each');
  assert.equal(
    body.tasks.filter((task) => task.source === 'agent').length,
    2,
    'the unattended plan did not create its follow-up',
  );

  const created = body.tasks.find((task) => task.source === 'agent');
  assert.ok(created, 'the follow-up the agent scheduled is not listed');
  assert.ok(created.title.length > 0);
  assert.ok(created.dueAt, 'a follow-up with no due date cannot be followed up');
  assert.ok(['high', 'medium', 'low'].includes(created.priority));
  assert.ok(created.contactName || created.companyName, 'the task is linked to nothing');

  const open = await handleListTasks(ctx.repos, { status: 'open' });
  assert.ok(open.body.tasks.every((task) => task.status === 'open'));

  await ctx.close();
});

// --- audit -------------------------------------------------------------------

test('audit lists events chronologically with actor and outcome', async () => {
  const ctx = await withAgentRecords();

  const { body } = await handleListAudit(ctx.repos);
  assert.ok(body.events.length > 0);
  assert.ok(body.total >= body.events.length);

  for (const event of body.events) {
    assert.ok(['system', 'ai', 'human'].includes(event.actor));
    assert.ok(['ok', 'blocked', 'failed', 'skipped'].includes(event.outcome));
    assert.ok(event.eventType.length > 0);
    assert.ok(event.summary.length > 0);
    assert.ok(event.createdAt.length > 0);
  }

  const human = await handleListAudit(ctx.repos, { actor: 'human' });
  assert.ok(human.body.events.every((event) => event.actor === 'human'));

  const blocked = await handleListAudit(ctx.repos, { outcome: 'blocked' });
  assert.ok(blocked.body.events.every((event) => event.outcome === 'blocked'));

  await ctx.close();
});

test('the audit list never carries a payload, and never message content', async () => {
  // The payload is bounded and identifier-safe (M5-F), but it is written for an
  // operator reading one email's trail with the email in front of them. In a
  // system-wide list a stray field could surface out of context, so the list
  // omits it entirely — the full payload stays on the email's own page.
  const ctx = await withAgentRecords();

  const { body } = await handleListAudit(ctx.repos);
  const serialised = JSON.stringify(body);

  for (const event of body.events) {
    assert.equal((event as Record<string, unknown>).payload, undefined, 'the audit list exposed a payload');
  }

  const emails = await ctx.repos.emails.list({ limit: 50 });
  for (const email of emails) {
    const fragment = email.bodyText.slice(0, 40);
    if (fragment.length < 20) continue;
    assert.ok(!serialised.includes(fragment), 'the audit list leaked an email body');
  }
  assert.ok(!/scrypt\$|sk-|inbox_session|password/i.test(serialised), 'the audit list leaked a credential');

  await ctx.close();
});

// --- paging and validation ---------------------------------------------------

test('paging accepts query-string numbers, which arrive as strings', async () => {
  // `optionalInteger` in lib/validate requires an actual number — correct for a
  // JSON body, wrong for a query string, where Express hands over `'50'`.
  const ctx = await withAgentRecords();

  const paged = await handleListDeals(ctx.repos, { limit: '2', offset: '0' });
  assert.equal(paged.body.deals.length, 2, 'a string limit was not honoured');

  const second = await handleListDeals(ctx.repos, { limit: '2', offset: '2' });
  assert.notDeepEqual(second.body.deals[0]?.id, paged.body.deals[0]?.id, 'offset had no effect');

  // The total is the whole set, not the page.
  assert.equal(paged.body.total, 5);

  await ctx.close();
});

test('nonsense paging is refused rather than silently ignored', async () => {
  const ctx = await createTestContext({ idPrefix: 'paging' });

  for (const query of [{ limit: 'lots' }, { limit: '0' }, { limit: '9999' }, { offset: '-1' }]) {
    const err = await rejects(() => handleListDeals(ctx.repos, query));
    assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR', `${JSON.stringify(query)} was accepted`);
  }

  await ctx.close();
});

// --- empty states ------------------------------------------------------------

test('an empty CRM returns empty lists, never an error', async () => {
  const ctx = await createTestContext({ idPrefix: 'empty' });

  assert.deepEqual((await handleListDeals(ctx.repos)).body, { deals: [], total: 0 });
  assert.deepEqual((await handleListContacts(ctx.repos)).body, { contacts: [], total: 0 });
  assert.deepEqual((await handleListCompanies(ctx.repos)).body, { companies: [], total: 0 });
  assert.deepEqual((await handleListTasks(ctx.repos)).body, { tasks: [], total: 0 });
  assert.deepEqual((await handleListAudit(ctx.repos)).body, { events: [], total: 0 });

  await ctx.close();
});

test('soft-deleted records are not listed', async () => {
  const ctx = await withAgentRecords();

  const before = (await handleListDeals(ctx.repos)).body;
  const target = before.deals[0];
  assert.ok(target);

  await ctx.repos.deals.softDelete(target.id);

  const after = (await handleListDeals(ctx.repos)).body;
  assert.equal(after.deals.find((deal) => deal.id === target.id), undefined, 'a deleted deal is still listed');
  assert.equal(after.total, before.total - 1);

  await ctx.close();
});

// --- the read-only guarantee -------------------------------------------------

test('the CRM router exposes no way to write', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/routes/crm.ts', import.meta.url), 'utf8');

  for (const verb of ['router.post', 'router.put', 'router.patch', 'router.delete']) {
    assert.ok(!source.includes(verb), `the CRM router exposes ${verb}`);
  }
  assert.match(source, /router\.get/);
});

test('CRM endpoints require a session', async () => {
  const { db, close } = await createTestContext({ idPrefix: 'crm-auth' });
  const server = await startAuthenticatedServer(db);

  try {
    for (const path of ['/api/deals', '/api/contacts', '/api/companies', '/api/tasks', '/api/audit']) {
      const anonymous = await fetch(`${server.url}${path}`);
      assert.equal(anonymous.status, 401, `${path} was reachable without a session`);

      const authenticated = await fetch(`${server.url}${path}`, { headers: { cookie: server.cookie } });
      assert.equal(authenticated.status, 200, `${path} was refused to a signed-in operator`);
    }

    // And a write verb does not exist on them.
    const write = await fetch(`${server.url}/api/deals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: server.cookie, 'x-csrf-token': server.csrf },
      body: '{}',
    });
    assert.equal(write.status, 404, 'POST /api/deals resolved to something');
  } finally {
    await server.stop();
    await close();
  }
});
