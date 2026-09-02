import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, rejects } from './helpers.ts';

// Repository integration tests: real migrations, real SQL, in-memory database.
// Nothing is mocked, so these exercise the same code paths a request does.

// --- CRM CRUD (FR-34) -------------------------------------------------------

test('a company round-trips and computes its match key', async () => {
  const { repos, close } = await createTestContext();

  const created = await repos.companies.create({
    name: 'Harborview Media Ltd',
    domain: 'HarborviewMedia.INVALID',
    source: 'human',
  });

  assert.equal(created.name, 'Harborview Media Ltd');
  assert.equal(created.nameNorm, 'harborview media', 'name_norm is the stored match key');
  assert.equal(created.domain, 'harborviewmedia.invalid', 'domains are normalised on write');
  assert.equal(created.source, 'human');

  const fetched = await repos.companies.getById(created.id);
  assert.deepEqual(fetched, created);
  await close();
});

test('a duplicate company domain is a domain-language conflict, not a driver error', async () => {
  const { repos, close } = await createTestContext();
  await repos.companies.create({ name: 'Lantern Studio', domain: 'lanternstudio.invalid', source: 'seed' });

  const err = await rejects(() =>
    repos.companies.create({ name: 'Lantern Studio Two', domain: 'lanternstudio.invalid', source: 'agent' }),
  );
  assert.match(err.message, /already exists/);
  assert.equal((err as { code?: string }).code, 'CONFLICT');
  await close();
});

test('contacts are found by email case-insensitively', async () => {
  const { repos, close } = await createTestContext();
  await repos.contacts.create({ fullName: 'Elena Marsh', email: 'Elena@Harborview.INVALID', source: 'seed' });

  const found = await repos.contacts.findByEmail('elena@harborview.invalid');
  assert.ok(found);
  assert.equal(found.fullName, 'Elena Marsh');
  await close();
});

test('a duplicate contact email is rejected', async () => {
  const { repos, close } = await createTestContext();
  await repos.contacts.create({ fullName: 'A', email: 'dup@example.com', source: 'seed' });
  const err = await rejects(() => repos.contacts.create({ fullName: 'B', email: 'DUP@example.com', source: 'agent' }));
  assert.equal((err as { code?: string }).code, 'CONFLICT');
  await close();
});

test('deal money stays an integer in minor units through a round trip', async () => {
  const { repos, close } = await createTestContext();
  const deal = await repos.deals.create({ title: 'Test deal', amountMinor: 180000, source: 'seed' });

  assert.equal(deal.amountMinor, 180000);
  assert.equal(typeof deal.amountMinor, 'number', 'BIGINT must not surface as a string');
  assert.equal(deal.stage, 'new_lead', 'a new deal starts as a lead');
  assert.equal(deal.currency, 'USD');
  await close();
});

test('updating a record changes updated_at and leaves created_at alone', async () => {
  const { repos, close } = await createTestContext();
  const deal = await repos.deals.create({ title: 'Before', source: 'human' });
  const updated = await repos.deals.update(deal.id, { title: 'After', stage: 'qualifying' });

  assert.equal(updated.title, 'After');
  assert.equal(updated.stage, 'qualifying');
  assert.equal(updated.createdAt, deal.createdAt);
  assert.ok(updated.updatedAt > deal.updatedAt);
  await close();
});

test('an update with no changed fields is a safe no-op', async () => {
  const { repos, close } = await createTestContext();
  const contact = await repos.contacts.create({ fullName: 'Nobody', email: 'n@example.com', source: 'human' });
  const again = await repos.contacts.update(contact.id, {});
  assert.deepEqual(again, contact);
  await close();
});

test('updating a record that does not exist reports NOT_FOUND', async () => {
  const { repos, close } = await createTestContext();
  const err = await rejects(() => repos.deals.update('missing-id', { title: 'x' }));
  assert.equal((err as { code?: string }).code, 'NOT_FOUND');
  await close();
});

// --- soft delete (§11) ------------------------------------------------------

test('a soft-deleted record disappears from reads but is not destroyed', async () => {
  const { repos, close } = await createTestContext();
  const company = await repos.companies.create({ name: 'Gone Ltd', domain: 'gone.example', source: 'human' });

  await repos.companies.softDelete(company.id);

  assert.equal(await repos.companies.getById(company.id), null);
  assert.equal(await repos.companies.findByDomain('gone.example'), null);
  assert.equal((await repos.companies.list()).length, 0);
  assert.equal(await repos.companies.count(), 0);

  const withDeleted = await repos.companies.getById(company.id, { includeDeleted: true });
  assert.ok(withDeleted, 'the row is still there — "deleted" means hidden, not destroyed');
  assert.ok(withDeleted.deletedAt);
  await close();
});

test('soft-deleting frees the unique domain and email for reuse', async () => {
  const { repos, close } = await createTestContext();
  const company = await repos.companies.create({ name: 'First', domain: 'reuse.example', source: 'human' });
  await repos.companies.softDelete(company.id);

  const replacement = await repos.companies.create({ name: 'Second', domain: 'reuse.example', source: 'human' });
  assert.notEqual(replacement.id, company.id);

  const contact = await repos.contacts.create({ fullName: 'First', email: 'reuse@example.com', source: 'human' });
  await repos.contacts.softDelete(contact.id);
  await repos.contacts.create({ fullName: 'Second', email: 'reuse@example.com', source: 'human' });
  await close();
});

test('soft-deleting twice reports NOT_FOUND rather than silently succeeding', async () => {
  const { repos, close } = await createTestContext();
  const task = await repos.tasks.create({ title: 'Once', source: 'human' });
  await repos.tasks.softDelete(task.id);
  const err = await rejects(() => repos.tasks.softDelete(task.id));
  assert.equal((err as { code?: string }).code, 'NOT_FOUND');
  await close();
});

// --- tasks and timelines ----------------------------------------------------

test('completing a task records when it happened', async () => {
  const { repos, close } = await createTestContext();
  const task = await repos.tasks.create({ title: 'Follow up', priority: 'high', source: 'agent' });
  assert.equal(task.status, 'open');
  assert.equal(task.completedAt, null);

  const done = await repos.tasks.complete(task.id);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt);
  await close();
});

test('open tasks with a due date sort before undated ones', async () => {
  const { repos, close } = await createTestContext();
  await repos.tasks.create({ title: 'No date', source: 'human' });
  await repos.tasks.create({ title: 'Later', dueAt: '2026-09-01T00:00:00.000Z', source: 'human' });
  await repos.tasks.create({ title: 'Sooner', dueAt: '2026-08-01T00:00:00.000Z', source: 'human' });

  const tasks = await repos.tasks.list({ status: 'open' });
  assert.deepEqual(
    tasks.map((task) => task.title),
    ['Sooner', 'Later', 'No date'],
  );
  await close();
});

test('an entity timeline returns its activities newest first', async () => {
  const { repos, close } = await createTestContext();
  const contact = await repos.contacts.create({ fullName: 'Dana', email: 'dana@example.com', source: 'seed' });

  await repos.activities.create({ type: 'email_in', direction: 'inbound', subject: 'First', occurredAt: '2026-08-01T00:00:00.000Z', contactId: contact.id, source: 'seed' });
  await repos.activities.create({ type: 'email_out', direction: 'outbound', subject: 'Second', occurredAt: '2026-08-05T00:00:00.000Z', contactId: contact.id, source: 'agent' });

  const timeline = await repos.activities.listForEntity('contact', contact.id);
  assert.deepEqual(
    timeline.map((item) => item.subject),
    ['Second', 'First'],
  );
  await close();
});

// --- emails (FR-2 dedupe, §8 state) -----------------------------------------

const SAMPLE_EMAIL = {
  provider: 'demo' as const,
  providerMessageId: 'msg-1',
  threadId: null,
  fromName: 'Sarah Williams',
  fromEmail: 'sarah@acmecommerce.invalid',
  toEmail: 'hello@example.test',
  cc: null,
  subject: 'Shopify AI chatbot project',
  bodyText: 'Could you tell us roughly how much this would cost?',
  headers: { 'message-id': '<msg-1@acmecommerce.invalid>' },
  receivedAt: '2026-08-24T09:00:00.000Z',
};

test('an ingested email starts in received with a correlation id', async () => {
  const { repos, close } = await createTestContext();
  const { email, created } = await repos.emails.insertIfNew(SAMPLE_EMAIL);

  assert.equal(created, true);
  assert.equal(email.state, 'received');
  assert.equal(email.reviewReason, null);
  assert.ok(email.correlationId);
  assert.deepEqual(email.headers, { 'message-id': '<msg-1@acmecommerce.invalid>' });
  await close();
});

test('re-ingesting the same message is a no-op, not a duplicate lead', async () => {
  const { repos, close } = await createTestContext();
  const first = await repos.emails.insertIfNew(SAMPLE_EMAIL);
  const second = await repos.emails.insertIfNew(SAMPLE_EMAIL);

  assert.equal(second.created, false);
  assert.equal(second.email.id, first.email.id);
  assert.equal(await repos.emails.count(), 1);
  await close();
});

test('the same message id from a different provider is a different email', async () => {
  const { repos, close } = await createTestContext();
  await repos.emails.insertIfNew(SAMPLE_EMAIL);
  const other = await repos.emails.insertIfNew({ ...SAMPLE_EMAIL, provider: 'gmail' });

  assert.equal(other.created, true);
  assert.equal(await repos.emails.count(), 2);
  await close();
});

test('a state transition applies only from the expected state', async () => {
  const { repos, close } = await createTestContext();
  const { email } = await repos.emails.insertIfNew(SAMPLE_EMAIL);

  const moved = await repos.emails.setState(email.id, 'understanding', { expectedFrom: 'received' });
  assert.ok(moved);
  assert.equal(moved.state, 'understanding');

  // Someone else already moved it on: the update must not silently overwrite.
  const stale = await repos.emails.setState(email.id, 'deciding', { expectedFrom: 'received' });
  assert.equal(stale, null, 'a transition from the wrong state must fail, not overwrite');

  const current = await repos.emails.getById(email.id);
  assert.equal(current?.state, 'understanding');
  await close();
});

test('routing to review records a machine-readable reason', async () => {
  const { repos, close } = await createTestContext();
  const { email } = await repos.emails.insertIfNew(SAMPLE_EMAIL);

  const reviewed = await repos.emails.setState(email.id, 'needs_review', { reviewReason: 'low_confidence' });
  assert.equal(reviewed?.state, 'needs_review');
  assert.equal(reviewed?.reviewReason, 'low_confidence');
  await close();
});

test('a state outside the schema is rejected by the database', async () => {
  const { repos, close } = await createTestContext();
  const { email } = await repos.emails.insertIfNew(SAMPLE_EMAIL);
  const err = await rejects(() => repos.emails.setState(email.id, 'invented_state' as 'received'));
  assert.match(err.message, /CHECK constraint/i);
  await close();
});

// --- audit (§17) ------------------------------------------------------------

test('audit events are numbered per run, in order', async () => {
  const { repos, close } = await createTestContext();
  const correlationId = 'run-1';

  const first = await repos.audit.append({
    correlationId, stage: 'ingest', eventType: 'email_received', actor: 'system', outcome: 'ok',
    summary: 'Email received.',
  });
  const second = await repos.audit.append({
    correlationId, stage: 'understand', eventType: 'classification_recorded', actor: 'ai', actorId: 'mock',
    outcome: 'ok', summary: 'Classified as a sales inquiry.', payload: { category: 'sales_inquiry' }, latencyMs: 12,
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(second.payload, { category: 'sales_inquiry' });
  assert.equal(second.actor, 'ai');
  assert.equal(second.latencyMs, 12);

  const run = await repos.audit.listByCorrelation(correlationId);
  assert.deepEqual(run.map((event) => event.sequence), [1, 2]);
  await close();
});

test('sequences are independent per run', async () => {
  const { repos, close } = await createTestContext();
  await repos.audit.append({ correlationId: 'a', stage: 'system', eventType: 'state_changed', actor: 'system', outcome: 'ok', summary: 'x' });
  const b = await repos.audit.append({ correlationId: 'b', stage: 'system', eventType: 'state_changed', actor: 'system', outcome: 'ok', summary: 'y' });
  assert.equal(b.sequence, 1);
  await close();
});

test('the audit repository exposes no way to change or remove an event', () => {
  // The append-only guarantee is the absence of a function to call, so this
  // asserts the shape of the interface itself rather than a behaviour.
  const forbidden = ['update', 'delete', 'remove', 'upsert', 'clear', 'truncate', 'set'];
  return createTestContext().then(async ({ repos, close }) => {
    for (const method of forbidden) {
      assert.equal(
        (repos.audit as unknown as Record<string, unknown>)[method],
        undefined,
        `audit repository must not expose "${method}"`,
      );
    }
    await close();
  });
});

test('audit events can be filtered by actor', async () => {
  const { repos, close } = await createTestContext();
  await repos.audit.append({ correlationId: 'r', stage: 'decide', eventType: 'plan_created', actor: 'ai', outcome: 'ok', summary: 'ai did a thing' });
  await repos.audit.append({ correlationId: 'r', stage: 'approval', eventType: 'approval_granted', actor: 'human', outcome: 'ok', summary: 'a person approved it' });

  const humanEvents = await repos.audit.list({ actor: 'human' });
  assert.equal(humanEvents.length, 1);
  assert.equal(humanEvents[0]?.eventType, 'approval_granted');
  await close();
});

// --- settings ---------------------------------------------------------------

test('settings fall back to code defaults before anything is stored', async () => {
  const { repos, close } = await createTestContext();
  assert.equal(await repos.settings.get('autonomy_level'), 'manual', 'a fresh install asks about everything');
  assert.equal(await repos.settings.get('outbound_send_enabled'), false);
  await close();
});

test('a stored setting round-trips as structured JSON', async () => {
  const { repos, close } = await createTestContext();
  await repos.settings.set('confidence_thresholds', { high: 0.85, medium: 0.6 }, 'sameer');
  assert.deepEqual(await repos.settings.get('confidence_thresholds'), { high: 0.85, medium: 0.6 });

  await repos.settings.set('autonomy_level', 'assisted', 'sameer');
  const all = await repos.settings.getAll();
  assert.equal(all.autonomy_level, 'assisted');
  assert.equal(all.approval_sla_hours, 24, 'unset keys still come back as their defaults');
  await close();
});

test('seeding defaults twice does not duplicate rows', async () => {
  const { repos, db, close } = await createTestContext();
  await repos.settings.seedDefaults();
  await repos.settings.seedDefaults();

  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM settings');
  assert.equal(Number(rows[0]?.n), 5);
  await close();
});

// --- transactions -----------------------------------------------------------

test('a failed transaction leaves nothing behind', async () => {
  const { repos, close } = await createTestContext();

  await rejects(() =>
    repos.db.transaction(async () => {
      await repos.companies.create({ name: 'Rolled Back', domain: 'rollback.example', source: 'agent' });
      throw new Error('something went wrong halfway');
    }),
  );

  assert.equal(await repos.companies.count(), 0, 'the CRM must be untouched after a failed write');
  await close();
});

test('a nested transaction rolls back to its savepoint without losing the outer work', async () => {
  const { repos, close } = await createTestContext();

  await repos.db.transaction(async () => {
    await repos.companies.create({ name: 'Outer', domain: 'outer.example', source: 'agent' });

    await rejects(() =>
      repos.db.transaction(async () => {
        await repos.companies.create({ name: 'Inner', domain: 'inner.example', source: 'agent' });
        throw new Error('inner failed');
      }),
    );
  });

  const companies = await repos.companies.list();
  assert.deepEqual(companies.map((company) => company.name), ['Outer']);
  await close();
});
