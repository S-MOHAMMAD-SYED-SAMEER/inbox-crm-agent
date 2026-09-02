import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, configSummary } from '../src/config/env.ts';
import { handleHealth } from '../src/handlers/health.ts';
import { DEMO_DATA_DIR, MIGRATION_COUNT, createTestContext, rejects } from './helpers.ts';
import { readSeedFile, seedDemoData, clearAllData, parseSeedFile } from '../src/db/seed.ts';
import { DEFAULT_SETTINGS } from '../src/db/repositories/index.ts';

// ============================================================ configuration

test('a bare environment produces a working, key-free configuration', () => {
  const { config, ok, problems } = loadConfig({});

  // CONTRACT CHANGE (M5-A): a bare environment is no longer "ok", and should not
  // be. Without OPERATOR_PASSWORD_HASH nobody can sign in, so the application is
  // genuinely misconfigured — and the problem names the command that fixes it.
  // Everything else still needs no key, no account and no service (D3).
  assert.equal(ok, false);
  assert.deepEqual(problems, [
    'OPERATOR_PASSWORD_HASH is not set, so nobody can sign in. Generate one with `npm run hash-password`.',
  ]);
  assert.equal(config.llmProvider, 'mock', 'D3: the demo runs for free by default');
  assert.equal(config.dbDriver, 'sqlite');
  assert.equal(config.databaseUrl, null);
  assert.equal(config.allowOutboundSend, false);
  assert.equal(config.autonomyLevel, 'manual');
  assert.equal(config.port, 3100, 'Project 1 owns 3000; both must be able to run at once');
});

test('a postgres URL selects the postgres driver', () => {
  const { config } = loadConfig({ DATABASE_URL: 'postgresql://user:pw@host/db' });
  assert.equal(config.dbDriver, 'postgres');
  assert.equal(config.databaseUrl, 'postgresql://user:pw@host/db');
});

test('a DATABASE_URL that is not postgres falls back to local SQLite with a warning', () => {
  const { config, problems } = loadConfig({ DATABASE_URL: 'mysql://host/db' });
  assert.equal(config.dbDriver, 'sqlite');
  assert.equal(config.databaseUrl, null);
  assert.ok(problems.some((problem) => /not a postgres/i.test(problem)));
});

test('an unbuilt adapter falls back and says so', () => {
  const gmail = loadConfig({ EMAIL_SOURCE: 'gmail' });
  assert.equal(gmail.config.emailSource, 'demo');
  assert.ok(gmail.problems.some((problem) => /not implemented/i.test(problem)));

  const hubspot = loadConfig({ CRM_TARGET: 'hubspot' });
  assert.equal(hubspot.config.crmTarget, 'local');
  assert.ok(hubspot.problems.some((problem) => /not implemented/i.test(problem)));
});

test('a provider selected without its key is reported to the operator', () => {
  const { problems } = loadConfig({ LLM_PROVIDER: 'anthropic' });
  assert.ok(problems.some((problem) => /ANTHROPIC_API_KEY/.test(problem)));
});

test('an unknown enum value falls back to the default rather than crashing', () => {
  const { config, problems } = loadConfig({ LLM_PROVIDER: 'gpt-9', AUTONOMY_LEVEL: 'yolo' });
  assert.equal(config.llmProvider, 'mock');
  assert.equal(config.autonomyLevel, 'manual');

  // CONTRACT CHANGE (M5-A): the unset operator password is a third problem.
  assert.equal(problems.filter((problem) => /gpt-9|yolo/.test(problem)).length, 2);
  assert.equal(problems.length, 3);
});

test('outbound sending needs both locks turned, and neither alone is enough', () => {
  // CONTRACT CHANGE (M4-D): outbound delivery exists now, so the flag no longer
  // reports "not implemented" — it reports which of the two locks is still shut.
  // Both are server-side environment values; nothing a browser sends is read.

  // The default: nothing can send.
  const off = loadConfig({});
  assert.equal(off.config.allowOutboundSend, false);
  assert.equal(off.config.outboundProvider, 'none');
  assert.equal(configSummary(off.config).outboundSendEnabled, false);

  // Flag alone: still cannot send, and says so.
  const flagOnly = loadConfig({ ALLOW_OUTBOUND_SEND: 'true' });
  assert.equal(flagOnly.config.allowOutboundSend, true);
  assert.equal(configSummary(flagOnly.config).outboundSendEnabled, false);
  assert.ok(flagOnly.problems.some((problem) => /no mail can be sent/i.test(problem)));

  // Provider alone: still cannot send, and says so.
  const providerOnly = loadConfig({ OUTBOUND_PROVIDER: 'mock' });
  assert.equal(configSummary(providerOnly.config).outboundSendEnabled, false);
  assert.ok(providerOnly.problems.some((problem) => /nothing will be sent/i.test(problem)));

  // Gmail is a declared name with nothing behind it.
  const gmail = loadConfig({ ALLOW_OUTBOUND_SEND: 'true', OUTBOUND_PROVIDER: 'gmail' });
  assert.equal(configSummary(gmail.config).outboundSendEnabled, false);
  assert.ok(gmail.problems.some((problem) => /not implemented/i.test(problem)));

  // Both turned: enabled, and loudly reported on every boot.
  const on = loadConfig({ ALLOW_OUTBOUND_SEND: 'true', OUTBOUND_PROVIDER: 'mock' });
  assert.equal(configSummary(on.config).outboundSendEnabled, true);
  assert.ok(on.problems.some((problem) => /OUTBOUND SENDING IS ENABLED/.test(problem)));
});

test('the config summary never exposes a secret (FR-46)', () => {
  const { config } = loadConfig({
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
    DATABASE_URL: 'postgresql://user:hunter2@db.example/app',
  });

  const summary = JSON.stringify(configSummary(config));
  assert.doesNotMatch(summary, /sk-ant|hunter2|db\.example/);
  assert.match(summary, /"llmConfigured":true/, 'it may report that a key exists, never what it is');
});

test('loading config does not mutate the real environment', () => {
  const before = process.env.LLM_PROVIDER;
  loadConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'x' });
  assert.equal(process.env.LLM_PROVIDER, before);
});

// ============================================================ health

test('health reports ok with a reachable database and its migration count', async () => {
  const { db, close } = await createTestContext();
  const { status, body } = await handleHealth({ db });

  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database.reachable, true);
  assert.equal(body.database.migrationsApplied, MIGRATION_COUNT);
  // CONTRACT CHANGE (M6-E): the version is a product version, not a milestone
  // label. It is rendered on an operator surface, where "M4-B" read as a
  // pre-release build marker. The rule is the assertion, not the number:
  assert.equal(body.version, '1.0.0');
  assert.doesNotMatch(body.version, /^M\d/, 'the version reads as a milestone label');
  await close();
});

test('health reports degraded — still 200 — when the database is gone', async () => {
  const { db, close } = await createTestContext();
  await close();

  const { status, body } = await handleHealth({ db });
  assert.equal(status, 200, 'the service is up and answering; that is what liveness asks');
  assert.equal(body.status, 'degraded');
  assert.equal(body.database.reachable, false);
});

test('health never leaks a secret', async () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-leak-me' });
  const { db, close } = await createTestContext();

  const { body } = await handleHealth({ db, config });
  assert.doesNotMatch(JSON.stringify(body), /sk-ant/);
  await close();
});

// ============================================================ seed

test('the shipped seed file matches the demo dataset the spec describes', async () => {
  const { repos, close } = await createTestContext();
  const counts = await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  assert.deepEqual(
    { companies: counts.companies, contacts: counts.contacts, deals: counts.deals, tasks: counts.tasks, activities: counts.activities, notes: counts.notes },
    { companies: 6, contacts: 9, deals: 4, tasks: 5, activities: 20, notes: 3 },
  );
  await close();
});

test('seeding twice changes nothing', async () => {
  const { repos, close } = await createTestContext();
  const file = readSeedFile(DEMO_DATA_DIR);

  await seedDemoData(repos, file);
  const second = await seedDemoData(repos, file);

  assert.equal(second.companies, 0);
  assert.equal(second.skipped, 47);
  assert.equal(await repos.companies.count(), 6);
  assert.equal(await repos.contacts.count(), 9);
  await close();
});

test('seeded ids are stable across a clear and reseed', async () => {
  const { repos, close } = await createTestContext();
  const file = readSeedFile(DEMO_DATA_DIR);

  await seedDemoData(repos, file);
  const before = (await repos.companies.list()).map((company) => company.id).sort();

  await clearAllData(repos);
  assert.equal(await repos.companies.count(), 0);

  await seedDemoData(repos, file);
  const after = (await repos.companies.list()).map((company) => company.id).sort();

  assert.deepEqual(after, before, 'a reset must restore the same state, ids included');
  await close();
});

test('seeded relationships resolve to real records', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  const contact = await repos.contacts.findByEmail('dana@solsticeretail.invalid');
  assert.ok(contact);
  assert.ok(contact.companyId);

  const company = await repos.companies.getById(contact.companyId);
  assert.equal(company?.name, 'Solstice Retail');

  const deals = await repos.deals.listByCompany(company?.id as string);
  assert.equal(deals.length, 1);
  assert.equal(deals[0]?.primaryContactId, contact.id);
  await close();
});

test('every seeded record is marked as seed data', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  for (const company of await repos.companies.list()) assert.equal(company.source, 'seed');
  for (const contact of await repos.contacts.list()) assert.equal(contact.source, 'seed');
  for (const deal of await repos.deals.list()) assert.equal(deal.source, 'seed');
  await close();
});

test('the seed contains a near-duplicate company pair for the match-conflict case', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  const companies = await repos.companies.list();
  const harborview = companies.filter((company) => company.nameNorm.startsWith('harborview'));
  assert.equal(harborview.length, 2, 'E-04 needs two plausible matches to be a genuine conflict');
  assert.notEqual(harborview[0]?.domain, harborview[1]?.domain);
  await close();
});

test('Acme Commerce is deliberately absent so the hero lead is genuinely new', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  assert.equal(await repos.companies.findByDomain('acmecommerce.invalid'), null);
  assert.equal(await repos.contacts.findByEmail('sarah@acmecommerce.invalid'), null);
  await close();
});

test('seeding installs the defaults, but demos at assisted autonomy', async () => {
  // CONTRACT CHANGE (M6-B): the demo seed now sets `assisted` deliberately.
  //
  // `manual` remains the default for a new installation — trust is earned with
  // evidence from a client's own inbox — but it is the wrong default for a
  // demo, where it hides half the product: nothing auto-executes and all ten
  // emails look identical. `assisted` shows both paths in one sitting.
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));

  const settings = await repos.settings.getAll();
  assert.equal(settings.autonomy_level, 'assisted', 'the demo does not show the auto-execute path');
  assert.equal(DEFAULT_SETTINGS.autonomy_level, 'manual', 'a new installation must still start manual');

  // Everything else still comes from the defaults, and outbound stays off.
  assert.equal(settings.outbound_send_enabled, false);
  assert.equal(settings.approval_sla_hours, DEFAULT_SETTINGS.approval_sla_hours);
  await close();
});

test('assisted autonomy still cannot auto-execute a consequential action', async () => {
  // The reason the demo default is safe to change at all. No autonomy level
  // permits tier 2, and that is enforced in the policy rather than in the seed.
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  assert.equal((await repos.settings.getAll()).autonomy_level, 'assisted');

  const { requiresApproval } = await import('../src/agent/policy/approval.ts');
  const verdict = requiresApproval({
    actions: [{ type: 'send_email', payload: null }],
    autonomyLevel: 'assisted',
    confidenceBand: 'high',
  });

  assert.equal(verdict.required, true, 'assisted autonomy allowed a reply to send itself');
  assert.equal(verdict.riskTier, 2);
  await close();
});

test('a seed file with a broken reference is rejected, naming the bad key', () => {
  const err = rejectsSync(() =>
    parseSeedFile({
      companies: [{ key: 'a', name: 'A' }],
      contacts: [{ key: 'b', fullName: 'B', email: 'b@example.com', companyKey: 'does-not-exist' }],
    }),
  );
  assert.match(err.message, /not valid/);
  const problems = (err as { details?: { problems?: string[] } }).details?.problems ?? [];
  assert.ok(problems.some((problem) => /does-not-exist/.test(problem)));
});

test('a seed file with duplicate keys is rejected', () => {
  const err = rejectsSync(() =>
    parseSeedFile({ companies: [{ key: 'a', name: 'A' }, { key: 'a', name: 'Also A' }] }),
  );
  const problems = (err as { details?: { problems?: string[] } }).details?.problems ?? [];
  assert.ok(problems.some((problem) => /duplicate key/.test(problem)));
});

test('clearing removes every row from every table', async () => {
  const { repos, close } = await createTestContext();
  await seedDemoData(repos, readSeedFile(DEMO_DATA_DIR));
  await clearAllData(repos);

  assert.equal(await repos.companies.count(), 0);
  assert.equal(await repos.contacts.count(), 0);
  assert.equal(await repos.deals.count(), 0);
  assert.equal(await repos.tasks.count(), 0);
  assert.equal(await repos.activities.count(), 0);
  assert.equal(await repos.notes.count(), 0);
  await close();
});

function rejectsSync(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected the call to throw, but it returned.');
}

// Keeps the async `rejects` helper imported and exercised in this file too.
test('the async rejects helper fails when nothing rejects', async () => {
  const err = await rejects(async () => {
    await rejects(async () => 'resolved fine');
  });
  assert.match(err.message, /Expected the operation to reject/);
});
