import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { MIGRATIONS_DIR, DEMO_DATA_DIR, TEST_OPERATOR_PASSWORD } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { GuestManager, DEFAULT_GUEST_LIMITS, type GuestLimits } from '../src/guest/manager.ts';
import { GUEST_COOKIE, GUEST_CSRF_COOKIE } from '../src/guest/http.ts';
import { SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import {
  NO_RECORDED_ANSWER,
  createRecordedProvider,
  loadRecording,
  parseRecording,
  replyKey,
  type Recording,
} from '../src/guest/recording.ts';
import { UNDERSTAND_PROMPT_VERSION } from '../src/agent/understand/prompt.ts';
import { DRAFT_PROMPT_VERSION } from '../src/agent/decide/draftPrompt.ts';
import { LlmUnavailableError, type LlmProvider } from '../src/adapters/llm/types.ts';
import { createMockOutboundSender } from '../src/adapters/outbound/index.ts';

// The guest demo: a visitor tries the whole flow without signing in, in a private sandbox that answers from a recorded real run.
//
// No model is called anywhere in this file. The owner's provider in every app below is one that fails the test if it is ever
// asked, and the guests' provider is the recording.

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const RECORDING_PATH = path.join(SERVER_ROOT, 'data', 'replay', 'recorded-run.json');
const recording = loadRecording(RECORDING_PATH);

/** A clock the test moves by hand. It starts at the real time so approvals, which the executor judges against the real clock, stay valid. */
function movableClock() {
  let ms = Date.now();
  return {
    nowIso: () => new Date(ms).toISOString(),
    advance(by: number) {
      ms += by;
    },
  };
}

/** A provider that fails the test if it is ever asked: the owner's, in apps that only guests use. */
function forbiddenProvider(calls: { count: number }): LlmProvider {
  return {
    name: 'mock',
    configured: true,
    async complete() {
      calls.count += 1;
      throw new Error('A model provider was called in a guest session.');
    },
  };
}

type Running = {
  url: string;
  clock: ReturnType<typeof movableClock>;
  manager: GuestManager;
  ownerProviderCalls: { count: number };
  ownerDb: ReturnType<typeof createTestDatabase>;
  stop(): Promise<void>;
};

async function start(
  options: { limits?: Partial<GuestLimits>; config?: Partial<AppConfig>; recording?: Recording; guestManager?: null } = {},
): Promise<Running> {
  const clock = movableClock();
  const ownerDb = createTestDatabase();
  await runMigrations(ownerDb, MIGRATIONS_DIR, { now: () => clock.nowIso() });
  const logger = createMemoryLogger().logger;
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(TEST_OPERATOR_PASSWORD),
    cookieSecure: false,
    guestDemo: true,
    ...options.config,
  };
  const rec = options.recording ?? recording;
  const manager = new GuestManager({
    build: { migrationsDir: MIGRATIONS_DIR, demoDataDir: DEMO_DATA_DIR, recording: rec, clock, logger },
    ...(options.limits ? { limits: options.limits } : {}),
    clock,
  });
  const ownerProviderCalls = { count: 0 };
  const app = createApp({
    db: ownerDb,
    config,
    logger,
    provider: forbiddenProvider(ownerProviderCalls),
    guestManager: options.guestManager === null ? null : manager,
    recording: rec,
  });
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    clock,
    manager,
    ownerProviderCalls,
    ownerDb,
    stop: async () => {
      await manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ownerDb.close();
    },
  };
}

/** A browser: a cookie jar, and the CSRF header the web client sends. */
class Browser {
  readonly jar = new Map<string, string>();
  lastSetCookie: string[] = [];
  private readonly base: string;
  private readonly ip: string;
  constructor(base: string, ip = '203.0.113.7') {
    this.base = base;
    this.ip = ip;
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  async call(
    pathname: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<{ status: number; body: any; setCookie: string[] }> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': this.ip, ...init.headers };
    const cookies = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (cookies) headers.cookie = cookies;
    if (method !== 'GET' && init.csrf !== false && !('x-csrf-token' in headers)) {
      const token = this.jar.get(CSRF_COOKIE) ?? this.jar.get(GUEST_CSRF_COOKIE);
      if (token) headers['x-csrf-token'] = token;
    }
    const response = await fetch(`${this.base}${pathname}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : method !== 'GET' ? { body: '{}' } : {}),
    });
    const setCookie = response.headers.getSetCookie();
    this.lastSetCookie = setCookie;
    for (const line of setCookie) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1));
      if (attrs.some((a) => /max-age=0/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, setCookie };
  }

  async tryTheDemo() {
    return this.call('/api/auth/guest', { method: 'POST', csrf: false });
  }

  async signInAsOwner() {
    return this.call('/api/auth/login', { method: 'POST', body: { password: TEST_OPERATOR_PASSWORD }, csrf: false });
  }
}

/** Runs the whole flow on all ten emails, as a guest would by clicking the four buttons. */
async function runFullFlow(browser: Browser) {
  const ingested = await browser.call('/api/emails/ingest', { method: 'POST' });
  assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
  assert.equal(ingested.body.ingested, 10);
  for (const step of ['understand', 'resolve', 'decide']) {
    const result = await browser.call(`/api/emails/${step}`, { method: 'POST' });
    assert.equal(result.status, 200, `${step}: ${JSON.stringify(result.body)}`);
  }
  const list = await browser.call('/api/emails');
  assert.equal(list.status, 200);
  return list.body.emails as Array<any>;
}

const byMessage = (emails: Array<any>, subject: string) => emails.find((email) => email.subject === subject);

// =============================================================================== the recording

test('the recording says where its answers come from, and has every answer the ten demo emails need', () => {
  assert.equal(recording.provenance.model, 'gemini-3.5-flash-lite');
  assert.equal(recording.provenance.recordedAt, '2026-10-17');
  assert.equal(recording.provenance.temperature, 1);
  assert.deepEqual(recording.provenance.promptVersions, { understand: UNDERSTAND_PROMPT_VERSION, draft: DRAFT_PROMPT_VERSION });
  assert.match(recording.provenance.run, /^1 of 3/);
  assert.match(recording.provenance.sourceReport, /run1\.json$/);
  const understood = recording.replies.filter((r) => r.purpose === 'understand').map((r) => r.fixtureId).sort();
  assert.deepEqual(understood, Array.from({ length: 10 }, (_, i) => `demo-e${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(recording.replies.filter((r) => r.purpose === 'draft').map((r) => r.fixtureId).sort(), ['demo-e01:draft', 'demo-e02:draft', 'demo-e03:draft']);
  // It matches the saved run it was taken from, reply for reply.
  const report = JSON.parse(fs.readFileSync(path.resolve(SERVER_ROOT, '..', recording.provenance.sourceReport), 'utf8')) as {
    items: Array<{ calls: Array<{ fixtureId: string; purpose: string; ok: boolean; response?: { toolInput: unknown } }> }>;
  };
  const saved = report.items.flatMap((item) => item.calls).filter((call) => call.ok);
  assert.equal(saved.length, recording.replies.length);
  for (const call of saved) {
    const mine = recording.replies.find((r) => r.fixtureId === call.fixtureId && r.purpose === call.purpose);
    assert.deepEqual(mine?.toolInput, call.response?.toolInput, `${call.fixtureId} ${call.purpose} differs from the saved run`);
  }
});

test('a reply is keyed by email, step AND prompt version: a changed prompt version is "no recorded answer", never an old answer', async () => {
  const provider = createRecordedProvider(recording);
  const ask = (fixtureId: string, purpose: string, promptVersion: string) =>
    provider.complete({ purpose, promptVersion, metadata: { fixtureId } } as never);

  const ok = await ask('demo-e01', 'understand', UNDERSTAND_PROMPT_VERSION);
  assert.equal(ok.model, 'gemini-3.5-flash-lite (recorded)', 'the answer says it was recorded');
  assert.equal(typeof ok.toolInput.category, 'string');

  for (const [fixtureId, purpose, version] of [
    ['demo-e01', 'understand', 'understand.v3'],
    ['demo-e01', 'understand', 'understand.v1'],
    ['demo-e01:draft', 'draft', 'draft.v2'],
    ['demo-e04:draft', 'draft', DRAFT_PROMPT_VERSION],
    ['demo-e99', 'understand', UNDERSTAND_PROMPT_VERSION],
  ] as const) {
    await assert.rejects(
      () => ask(fixtureId, purpose, version),
      (err: unknown) => err instanceof LlmUnavailableError && err.message === NO_RECORDED_ANSWER && err.kind === 'rejected',
      `${fixtureId} ${purpose} ${version} was answered`,
    );
  }
  assert.equal(NO_RECORDED_ANSWER, 'No recorded answer for this step.');
  assert.equal(replyKey('a', 'understand', 'understand.v2') === replyKey('a', 'understand', 'understand.v3'), false);
});

test('"Analyse again" replays the SAME recorded answer, every time, and a served answer cannot be altered for the next', async () => {
  const provider = createRecordedProvider(recording);
  const first = await provider.complete({ purpose: 'understand', promptVersion: UNDERSTAND_PROMPT_VERSION, metadata: { fixtureId: 'demo-e02' } } as never);
  (first.toolInput as Record<string, unknown>).category = 'tampered';
  const second = await provider.complete({ purpose: 'understand', promptVersion: UNDERSTAND_PROMPT_VERSION, metadata: { fixtureId: 'demo-e02' } } as never);
  const third = await provider.complete({ purpose: 'understand', promptVersion: UNDERSTAND_PROMPT_VERSION, metadata: { fixtureId: 'demo-e02' } } as never);
  assert.notEqual(second.toolInput.category, 'tampered');
  assert.deepEqual(second.toolInput, third.toolInput);
  assert.equal(provider.asked, 3);
});

test('a recording must say who, when and how; a malformed one is refused', () => {
  assert.throws(() => parseRecording({}), /not a recorded model run/);
  assert.throws(() => parseRecording({ ...recording, provenance: { ...recording.provenance, recordedAt: '' } }), /no recordedAt/);
  assert.throws(() => parseRecording({ ...recording, replies: [recording.replies[0], recording.replies[0]] }), /share/);
});

// ============================================================================ the whole flow

test('a guest runs the whole flow on all ten emails, and the results match the recorded run', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    const started = await guest.tryTheDemo();
    assert.equal(started.status, 201);
    assert.equal(started.body.role, 'guest');
    assert.equal(started.body.guest.model, 'gemini-3.5-flash-lite');
    assert.equal(started.body.guest.recordedAt, '2026-10-17');

    const emails = await runFullFlow(guest);
    assert.equal(emails.length, 10);

    const report = JSON.parse(fs.readFileSync(path.resolve(SERVER_ROOT, '..', recording.provenance.sourceReport), 'utf8')) as {
      items: Array<{ caseId: string; providerMessageId: string; understandState: string }>;
    };
    // Per email: the state UNDERSTAND left it in, and the plan DECIDE made, against the saved run.
    const detailFor = async (email: any) => (await guest.call(`/api/emails/${email.id}`)).body;
    const states: Record<string, { state: string; reason: string | null; category: string | null; modelCategory: string | null; actions: string[] }> = {};
    for (const email of emails) {
      const detail = await detailFor(email);
      states[detail.email.subject] = {
        state: detail.email.state,
        reason: detail.email.reviewReason,
        category: detail.analysis?.understanding.category ?? null,
        modelCategory: (detail.analysis?.modelOutput as { category?: string })?.category ?? null,
        actions: detail.decision?.plan.actions.map((a: { type: string }) => a.type) ?? [],
      };
    }

    // The model's own reading is exactly the recorded one for every email.
    const recordedCategory = (id: string): string => {
      const reply = recording.replies.find((r) => r.fixtureId === id && r.purpose === 'understand');
      assert.ok(reply, `no recorded reply for ${id}`);
      return (reply.toolInput as { category: string }).category;
    };
    assert.equal(states['Shopify AI chatbot project']?.modelCategory, recordedCategory('demo-e01'));
    assert.equal(states['Rebuilding our site']?.modelCategory, recordedCategory('demo-e02'));
    assert.equal(states['Reporting work for Harborview']?.modelCategory, recordedCategory('demo-e04'));
    assert.equal(states['Following up']?.modelCategory, recordedCategory('demo-e08'));

    // And where the saved run left each email, so does the sandbox.
    const savedUnderstand = new Map(report.items.map((item) => [item.providerMessageId, item.understandState]));
    const bySubject: Record<string, string> = {
      'demo-e01': 'Shopify AI chatbot project', 'demo-e02': 'Rebuilding our site', 'demo-e03': 'Cost for automating our client onboarding',
      'demo-e04': 'Reporting work for Harborview', 'demo-e05': 'Checkout step failing on mobile', 'demo-e06': 'Re: Support automation scope',
      'demo-e07': 'White-label partnership?', 'demo-e08': 'Following up', 'demo-e09': 'Your website is losing traffic - free audit inside',
      'demo-e10': 'Urgent order - please confirm pricing',
    };
    for (const [id, subject] of Object.entries(bySubject)) {
      const saved = savedUnderstand.get(id);
      const mine = states[subject]?.state;
      if (saved === 'needs_review') assert.equal(mine, 'needs_review', `${id}: the saved run handed it to a person`);
      else assert.notEqual(mine, 'needs_review', `${id}: the saved run did not hand it to a person`);
    }
    // The three that go to a person, and why.
    assert.equal(states['Reporting work for Harborview']?.state, 'needs_review');
    assert.equal(states['Following up']?.state, 'needs_review');
    assert.equal(states['Urgent order - please confirm pricing']?.reason, 'possible_injection');
    // The follow-up rule ran live on the recorded reading: the model said follow-up, the code changed it.
    assert.equal(states['Reporting work for Harborview']?.modelCategory, 'follow_up');
    assert.equal(states['Reporting work for Harborview']?.category, 'ambiguous');
    // A plan with a reply, a deal advance with a task and no reply, and an archive: the rules ran live (R-19, R-12, R-10).
    assert.ok(states['Shopify AI chatbot project']?.actions.includes('send_email'));
    assert.deepEqual(states['Re: Support automation scope']?.actions, ['log_activity', 'update_deal_stage', 'create_task']);
    assert.deepEqual(states['Your website is losing traffic - free audit inside']?.actions, ['archive_email']);
    // Nothing in a guest's sandbox runs unattended.
    for (const email of emails.filter((e) => e.state !== 'needs_review')) assert.equal(email.state, 'awaiting_approval', email.subject);

    assert.equal(app.ownerProviderCalls.count, 0, 'the owner\'s model provider was never asked');
  } finally {
    await app.stop();
  }
});

// =================================================== the code checks still run, live, on a replayed answer

test('the verbatim field check runs live in guest mode: an unwritten company is discarded; one the sender writes from is kept', async () => {
  // A recording whose E-01 answer claims a company the email never names, and whose E-02 answer claims one that the sender's domain
  // does name (acmecommerce for "Acme Commerce"). Everything else is the real recording.
  const altered = structuredClone(recording);
  const e01 = altered.replies.find((r) => r.fixtureId === 'demo-e01' && r.purpose === 'understand') as { toolInput: any };
  e01.toolInput.extracted.companyName = { value: 'Globex Corporation', confidence: 0.9, sourceSpan: 'Shopify store' };
  e01.toolInput.summary = 'Sarah Williams from Globex Corporation asks about a chatbot.';
  const e02 = altered.replies.find((r) => r.fixtureId === 'demo-e02' && r.purpose === 'understand') as { toolInput: any };
  e02.toolInput.extracted.companyName = { value: 'Northline Studio', confidence: 0.9, sourceSpan: 'Northline Studio' };

  const app = await start({ recording: altered });
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    await guest.call('/api/emails/ingest', { method: 'POST' });
    await guest.call('/api/emails/understand', { method: 'POST' });
    const emails = (await guest.call('/api/emails')).body.emails as Array<any>;
    const lead = await guest.call(`/api/emails/${byMessage(emails, 'Shopify AI chatbot project').id}`);

    // The check ran on the replayed answer: the unwritten company was dropped and the drop is on the record.
    assert.equal(lead.body.analysis.understanding.extracted.companyName.value, null);
    const dropped = lead.body.analysis.validation.droppedFields.find((d: any) => d.field === 'companyName');
    assert.equal(dropped?.claimedValue, 'Globex Corporation');
    assert.match(dropped?.reason ?? '', /not found in email/);
    // The model's own answer is kept beside it, unaltered.
    assert.equal(lead.body.analysis.modelOutput.extracted.companyName.value, 'Globex Corporation');
    // And the summary that names the discarded value is marked, not rewritten.
    assert.equal(lead.body.analysis.understanding.summary, 'Sarah Williams from Globex Corporation asks about a chatbot.');
    assert.equal(byMessage(emails, 'Shopify AI chatbot project').analysis.summaryMentionsDiscarded, true);

    // "Acme Commerce" (E-01's sender writes from acmecommerce.invalid): the sender's own domain names it, so it is KEPT by design.
    // The check is a live check on the replayed answer, not a blanket rule against the name.
    const acme = structuredClone(recording);
    const reply = acme.replies.find((r) => r.fixtureId === 'demo-e01' && r.purpose === 'understand') as { toolInput: any };
    reply.toolInput.extracted.companyName = { value: 'Acme Commerce', confidence: 0.9, sourceSpan: 'acmecommerce.invalid' };
    const second = await start({ recording: acme });
    try {
      const other = new Browser(second.url);
      await other.tryTheDemo();
      await other.call('/api/emails/ingest', { method: 'POST' });
      await other.call('/api/emails/understand', { method: 'POST' });
      const list = (await other.call('/api/emails')).body.emails as Array<any>;
      const detail = await other.call(`/api/emails/${byMessage(list, 'Shopify AI chatbot project').id}`);
      assert.equal(detail.body.analysis.understanding.extracted.companyName.value, 'Acme Commerce');
    } finally {
      await second.stop();
    }
  } finally {
    await app.stop();
  }
});

test('the follow-up check, the injection detector, the rules and the draft checks all run live on replayed answers', async () => {
  // Replace E-10's recorded answer with one that is FOOLED (it does not flag the injection): the detector, which runs live, must
  // still stop the email. Replace E-02's draft with one that promises a proposal: the live draft checks must block it.
  const altered = structuredClone(recording);
  const e10 = altered.replies.find((r) => r.fixtureId === 'demo-e10' && r.purpose === 'understand') as { toolInput: any };
  e10.toolInput.flags.possibleInjection = false;
  const draft = altered.replies.find((r) => r.fixtureId === 'demo-e02:draft') as { toolInput: any };
  draft.toolInput.body = 'Hi Tom,\n\nI will put together a proposal for the rebuild and send it over.\n\nAI Business Automation';

  const app = await start({ recording: altered });
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    const emails = await runFullFlow(guest);

    const injection = (await guest.call(`/api/emails/${byMessage(emails, 'Urgent order - please confirm pricing').id}`)).body;
    assert.equal(injection.analysis.security.injection.modelFlagged, false, 'the replayed answer did not flag it');
    assert.equal(injection.email.state, 'needs_review');
    assert.equal(injection.email.reviewReason, 'possible_injection', 'the detector stopped it anyway');

    const followUp = (await guest.call(`/api/emails/${byMessage(emails, 'Reporting work for Harborview').id}`)).body;
    assert.ok(followUp.analysis.validation.coherenceAdjustments.some((a: any) => a.rule === 'follow_up_without_context'));

    const rebuild = (await guest.call(`/api/emails/${byMessage(emails, 'Rebuilding our site').id}`)).body;
    assert.ok(rebuild.decision.plan.draft.blockedBy.some((v: any) => v.guardrail === 'no_unplanned_commitment'), 'the live draft checks blocked the promise');
    assert.equal(rebuild.decision.plan.requiresApproval, true);

    const advance = (await guest.call(`/api/emails/${byMessage(emails, 'Re: Support automation scope').id}`)).body;
    assert.ok(advance.decision.plan.ruleTrace.some((t: any) => t.rule === 'R-12' && t.fired));
    assert.ok(advance.decision.plan.ruleTrace.some((t: any) => t.rule === 'R-19'));
  } finally {
    await app.stop();
  }
});

test('a step with no recorded answer is shown honestly, and nothing is made up', async () => {
  const withoutDraft = structuredClone(recording);
  withoutDraft.replies = withoutDraft.replies.filter((r) => r.fixtureId !== 'demo-e01:draft' && r.fixtureId !== 'demo-e05');
  const app = await start({ recording: withoutDraft });
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    const emails = await runFullFlow(guest);
    const lead = (await guest.call(`/api/emails/${byMessage(emails, 'Shopify AI chatbot project').id}`)).body;
    assert.equal(lead.decision.plan.draft, null, 'no draft was invented');
    assert.match(lead.decision.plan.draftFailedReason ?? '', /could not be reached|no reply/i);
    const unread = (await guest.call(`/api/emails/${byMessage(emails, 'Checkout step failing on mobile').id}`)).body;
    assert.equal(unread.email.state, 'understand_failed');
    assert.equal(unread.analysis, null);
    assert.match(JSON.stringify(unread.audit), /could not be reached|not read/i);
  } finally {
    await app.stop();
  }
});

// ===================================================================== isolation

test('guest A\'s actions never appear for guest B or for the owner; the owner\'s data is unchanged', async () => {
  const app = await start();
  try {
    const owner = new Browser(app.url, '198.51.100.1');
    assert.equal((await owner.signInAsOwner()).status, 200);
    await owner.call('/api/emails/ingest', { method: 'POST' }).catch(() => undefined);

    const a = new Browser(app.url, '203.0.113.1');
    const b = new Browser(app.url, '203.0.113.2');
    await a.tryTheDemo();
    await b.tryTheDemo();
    const ownerBefore = (await owner.call('/api/emails')).body.emails.length;

    const emailsA = await runFullFlow(a);
    assert.equal(emailsA.length, 10);
    // B starts at the beginning, untouched; the owner's list is exactly what it was.
    assert.equal((await b.call('/api/emails')).body.emails.length, 0);
    assert.equal((await b.call('/api/audit')).body.events.length, 0);
    assert.equal((await owner.call('/api/emails')).body.emails.length, ownerBefore);
    assert.equal((await owner.call('/api/audit')).body.events.filter((e: any) => e.actorId === 'guest').length, 0);

    // A guest cannot reach another sandbox's records by id.
    const idOfA = emailsA[0].id;
    assert.equal((await b.call(`/api/emails/${idOfA}`)).status, 404);
    assert.equal((await owner.call(`/api/emails/${idOfA}`)).status, 404);

    // B's own actions stay in B.
    await b.call('/api/emails/ingest', { method: 'POST' });
    assert.equal((await b.call('/api/emails')).body.emails.length, 10);
    assert.notEqual((await b.call('/api/emails')).body.emails[0].id, idOfA);
    assert.equal(app.ownerProviderCalls.count, 0);
  } finally {
    await app.stop();
  }
});

test('a guest\'s approval is recorded as the guest, executes only inside its sandbox, and nothing is ever sent', async () => {
  // The server itself allows sending, with a mock provider: a guest still cannot send, because its sender is the refusing one.
  const app = await start({ config: { allowOutboundSend: true, outboundProvider: 'mock' } as Partial<AppConfig> });
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    const emails = await runFullFlow(guest);
    const lead = byMessage(emails, 'Shopify AI chatbot project');
    const decision = (await guest.call(`/api/emails/${lead.id}`)).body.decision;
    const approved = await guest.call(`/api/decisions/${decision.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.ok, true);
    assert.equal(approved.body.outboxStatus, 'suppressed', 'the reply was held, not sent');

    const detail = (await guest.call(`/api/emails/${lead.id}`)).body;
    const approval = detail.audit.find((event: any) => event.eventType === 'approval_granted');
    assert.equal(approval.actor, 'human');
    assert.equal(approval.actorId, 'guest');
    assert.equal(detail.outbox.status, 'suppressed');

    // The CRM changed inside the sandbox only.
    const deals = (await guest.call('/api/deals')).body;
    assert.ok(deals.deals.length >= 5);
    const owner = new Browser(app.url, '198.51.100.9');
    await owner.signInAsOwner();
    assert.equal((await owner.call('/api/deals')).body.deals.length, 0);
    assert.equal(app.ownerProviderCalls.count, 0);
  } finally {
    await app.stop();
  }
});

// ================================================================== roles, enforced in the server

test('a guest is refused (403) on everything outside its sandbox, including anything that would turn sending on or change settings', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    const refused = [
      ['POST', '/api/settings'],
      ['PUT', '/api/settings/autonomy'],
      ['POST', '/api/outbound/enable'],
      ['PUT', '/api/outbound'],
      ['POST', '/api/admin/anything'],
      ['GET', '/api/sessions'],
      ['POST', '/api/auth/login'],
    ] as const;
    for (const [method, route] of refused) {
      const result = await guest.call(route, method === 'GET' ? { method } : { method, body: route === '/api/auth/login' ? { password: 'x' } : { enabled: true } });
      if (route === '/api/auth/login') assert.equal(result.status, 401, 'the guest cookie is not a way past the password');
      else assert.equal(result.status, 403, `${method} ${route} answered ${result.status}`);
    }
    // A request cannot choose a role or a sandbox.
    const spoof = await guest.call('/api/emails', { headers: { 'x-role': 'owner', 'x-sandbox-id': 'someone-else', 'x-operator': 'operator' } });
    assert.equal(spoof.status, 200);
    assert.equal(spoof.body.emails.length, 0);
    const session = await guest.call('/api/auth/session');
    assert.equal(session.body.role, 'guest');
    assert.equal(session.body.operator, 'guest');
    assert.equal(app.ownerProviderCalls.count, 0);
  } finally {
    await app.stop();
  }
});

test('guest requests are verified like the owner\'s: a missing or wrong CSRF token is refused, a made-up cookie is no session', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    assert.equal((await guest.call('/api/emails/ingest', { method: 'POST', csrf: false })).status, 403);
    assert.equal((await guest.call('/api/emails/ingest', { method: 'POST', headers: { 'x-csrf-token': 'wrong' } })).status, 403);
    assert.equal((await guest.call('/api/emails/ingest', { method: 'POST' })).status, 200);

    const forger = new Browser(app.url);
    forger.jar.set(GUEST_COOKIE, 'a-token-nobody-issued');
    forger.jar.set(GUEST_CSRF_COOKIE, 'x');
    assert.equal((await forger.call('/api/emails')).status, 401);
    // The cookies are httpOnly and SameSite=Strict, and carry no password and no role.
    const fresh = new Browser(app.url);
    const started = await fresh.tryTheDemo();
    const session = started.setCookie.find((c) => c.startsWith(`${GUEST_COOKIE}=`)) ?? '';
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Strict/);
    assert.match(started.setCookie.find((c) => c.startsWith(`${GUEST_CSRF_COOKIE}=`)) ?? '', /SameSite=Strict/);
    assert.doesNotMatch(JSON.stringify(started.body), new RegExp(TEST_OPERATOR_PASSWORD));
  } finally {
    await app.stop();
  }
});

// ============================================================ one session per browser, the owner untouched

test('an owner is never turned into a guest, and a guest sign-out never signs the owner out', async () => {
  const app = await start();
  try {
    const browser = new Browser(app.url);
    assert.equal((await browser.signInAsOwner()).status, 200);
    const ownerToken = browser.cookie(SESSION_COOKIE);
    const ownerCsrf = browser.cookie(CSRF_COOKIE);
    assert.ok(ownerToken && ownerCsrf);

    // Owner cookie plus "Try the demo": refused, no cookie set at all, the owner session exactly as it was.
    const attempt = await browser.tryTheDemo();
    assert.equal(attempt.status, 409);
    assert.deepEqual(attempt.setCookie, [], 'no Set-Cookie: nothing was created, reused or changed');
    assert.equal(browser.cookie(SESSION_COOKIE), ownerToken);
    assert.equal(browser.cookie(CSRF_COOKIE), ownerCsrf);
    assert.equal(browser.cookie(GUEST_COOKIE), undefined);
    assert.equal(app.manager.size, 0, 'no sandbox was created');
    const stillOwner = await browser.call('/api/auth/session');
    assert.equal(stillOwner.body.role, 'owner');
    assert.equal(stillOwner.body.csrfToken, ownerCsrf);

    // A browser that holds BOTH cookies is the owner's: the guest cookie is ignored.
    const guest = new Browser(app.url, '203.0.113.50');
    await guest.tryTheDemo();
    browser.jar.set(GUEST_COOKIE, guest.cookie(GUEST_COOKIE) as string);
    browser.jar.set(GUEST_CSRF_COOKIE, guest.cookie(GUEST_CSRF_COOKIE) as string);
    assert.equal((await browser.call('/api/auth/session')).body.role, 'owner');

    // Guest sign-out from that browser deletes the sandbox, clears only the guest cookies, and the owner stays signed in.
    const left = await browser.call('/api/guest/leave', { method: 'POST' });
    assert.equal(left.status, 200);
    assert.ok(left.setCookie.every((c) => c.startsWith(GUEST_COOKIE) || c.startsWith(GUEST_CSRF_COOKIE)), `cleared ${left.setCookie.join(' | ')}`);
    assert.equal(browser.cookie(SESSION_COOKIE), ownerToken);
    assert.equal(browser.cookie(CSRF_COOKIE), ownerCsrf);
    assert.equal(app.manager.size, 0);
    assert.equal((await browser.call('/api/auth/session')).body.role, 'owner');
    assert.equal((await browser.call('/api/emails')).status, 200);
  } finally {
    await app.stop();
  }
});

test('owner sign-in and owner data are unchanged by the guest demo being there (and by it being off)', async () => {
  for (const enabled of [true, false]) {
    const app = await start({ config: { guestDemo: enabled }, ...(enabled ? {} : { guestManager: null }) });
    try {
      const owner = new Browser(app.url);
      assert.equal((await owner.call('/api/emails')).status, 401, 'no password, no access');
      const wrong = await owner.call('/api/auth/login', { method: 'POST', body: { password: 'wrong' }, csrf: false });
      assert.equal(wrong.status, 401);
      assert.equal((await owner.signInAsOwner()).status, 200);
      assert.equal((await owner.call('/api/emails')).status, 200);
      const session = (await owner.call('/api/auth/session')).body;
      assert.equal(session.role, 'owner');
      assert.equal(session.guestDemoEnabled, enabled);
      assert.equal((await owner.call('/api/auth/logout', { method: 'POST' })).status, 200);
      assert.equal((await owner.call('/api/emails')).status, 401);
    } finally {
      await app.stop();
    }
  }
});

test('GUEST_DEMO=false turns the guest demo off: no session starts, and the sign-in page is told not to offer it', async () => {
  const app = await start({ config: { guestDemo: false }, guestManager: null });
  try {
    const visitor = new Browser(app.url);
    const session = await visitor.call('/api/auth/session');
    assert.equal(session.body.guestDemoEnabled, false);
    const attempt = await visitor.tryTheDemo();
    assert.ok([401, 403, 404].includes(attempt.status), `answered ${attempt.status}`);
    assert.deepEqual(attempt.setCookie, []);
  } finally {
    await app.stop();
  }
});

// ===================================================================== lifecycle and limits

test('a sandbox is deleted on sign-out, after 30 minutes idle, and after 2 hours at most', async () => {
  const app = await start();
  try {
    // Sign-out.
    const a = new Browser(app.url, '203.0.113.11');
    await a.tryTheDemo();
    assert.equal(app.manager.size, 1);
    await a.call('/api/emails/ingest', { method: 'POST' });
    assert.equal((await a.call('/api/guest/leave', { method: 'POST' })).status, 200);
    assert.equal(app.manager.size, 0);
    assert.equal((await a.call('/api/emails')).status, 401, 'the sandbox is gone');

    // Idle.
    const b = new Browser(app.url, '203.0.113.12');
    await b.tryTheDemo();
    app.clock.advance(29 * 60_000);
    assert.equal((await b.call('/api/emails')).status, 200, 'activity keeps it alive');
    app.clock.advance(29 * 60_000);
    assert.equal((await b.call('/api/emails')).status, 200, 'and again');
    app.clock.advance(31 * 60_000);
    assert.equal(await app.manager.sweep(), 1, 'the sweep deletes the idle one');
    assert.equal(app.manager.size, 0);
    assert.equal((await b.call('/api/emails')).status, 401);

    // Two hours at most, however active.
    const c = new Browser(app.url, '203.0.113.13');
    await c.tryTheDemo();
    for (let i = 0; i < 5; i++) {
      app.clock.advance(20 * 60_000);
      assert.equal((await c.call('/api/emails')).status, 200, `minute ${(i + 1) * 20}`);
    }
    app.clock.advance(21 * 60_000);
    assert.equal((await c.call('/api/emails')).status, 401, 'past two hours it is gone even though it was active a minute ago');
    assert.equal(app.manager.size, 0);
  } finally {
    await app.stop();
  }
});

test('the time left is reported, and asking for it does not extend it', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    const started = await guest.tryTheDemo();
    const first = Date.parse(started.body.guest.expiresAt);
    app.clock.advance(10 * 60_000);
    const polled = await guest.call('/api/auth/session');
    assert.equal(Date.parse(polled.body.guest.expiresAt), first, 'polling the session did not restart the idle clock');
    await guest.call('/api/emails');
    const after = Date.parse((await guest.call('/api/auth/session')).body.guest.expiresAt);
    assert.equal(after - first, 10 * 60_000, 'a real request did');
    assert.equal(polled.body.guest.idleMinutes, 30);
    assert.equal(polled.body.guest.maxMinutes, 120);
  } finally {
    await app.stop();
  }
});

test('"Start over" returns the sandbox to the seed, and keeps the session', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    await runFullFlow(guest);
    const tokenBefore = guest.cookie(GUEST_COOKIE);
    const reset = await guest.call('/api/guest/reset', { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.reset, true);
    assert.equal((await guest.call('/api/emails')).body.emails.length, 0, 'back at the start');
    assert.equal((await guest.call('/api/audit')).body.events.length, 0);
    assert.equal(guest.cookie(GUEST_COOKIE), tokenBefore, 'the same session');
    assert.equal(app.manager.size, 1);
    // And it can be run again from the beginning.
    assert.equal((await runFullFlow(guest)).length, 10);
    // Without a guest session there is nothing to start over.
    assert.equal((await new Browser(app.url).call('/api/guest/reset', { method: 'POST', csrf: false })).status, 401);
  } finally {
    await app.stop();
  }
});

test('at most 20 sandboxes at once: the next visitor is told the demo is busy, and nothing is created for them', async () => {
  const app = await start({ limits: { maxSandboxes: 3, perIpPerHour: 100 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await new Browser(app.url, `203.0.113.${20 + i}`).tryTheDemo()).status, 201);
    const busy = new Browser(app.url, '203.0.113.99');
    const refused = await busy.tryTheDemo();
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.message, 'The demo is busy — try again in a few minutes.');
    assert.deepEqual(refused.setCookie, []);
    assert.equal(app.manager.size, 3);
    // A place frees up when one leaves.
    // (The first browser above is out of scope here; use the manager to free one.)
    app.clock.advance(31 * 60_000);
    assert.equal((await busy.tryTheDemo()).status, 201, 'idle sandboxes are swept to make room');
    assert.equal(DEFAULT_GUEST_LIMITS.maxSandboxes, 20);
  } finally {
    await app.stop();
  }
});

test('at most 5 new guest sessions per address per hour; another address is unaffected, and the hour passes', async () => {
  const app = await start({ limits: { perIpPerHour: 5, maxSandboxes: 50 }, config: { trustProxy: 1 } as Partial<AppConfig> });
  try {
    const ip = '203.0.113.200';
    for (let i = 0; i < 5; i++) assert.equal((await new Browser(app.url, ip).tryTheDemo()).status, 201, `session ${i + 1}`);
    const sixth = await new Browser(app.url, ip).tryTheDemo();
    assert.equal(sixth.status, 429);
    assert.deepEqual(sixth.setCookie, []);
    assert.ok(Number(sixth.body.error.details.retryAfterSeconds) > 0);
    assert.equal((await new Browser(app.url, '203.0.113.201').tryTheDemo()).status, 201, 'another address is not limited by this one');
    app.clock.advance(61 * 60_000);
    assert.equal((await new Browser(app.url, ip).tryTheDemo()).status, 201, 'an hour later it works again');
    assert.equal(DEFAULT_GUEST_LIMITS.perIpPerHour, 5);
  } finally {
    await app.stop();
  }
});

test('a guest session is rate limited as its own caller', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    let limited = false;
    for (let i = 0; i < 400 && !limited; i++) {
      const result = await guest.call('/api/emails');
      if (result.status === 429) limited = true;
    }
    assert.equal(limited, true, 'a guest cannot make unlimited requests');
    // Another guest is not affected by it.
    const other = new Browser(app.url, '203.0.113.77');
    await other.tryTheDemo();
    assert.equal((await other.call('/api/emails')).status, 200);
  } finally {
    await app.stop();
  }
});

test('the guest demo cannot call a model: not even asked, with a provider that fails the test if it is', async () => {
  const app = await start();
  try {
    const guest = new Browser(app.url);
    await guest.tryTheDemo();
    await runFullFlow(guest);
    // "Analyse again" on every email, many times.
    const emails = (await guest.call('/api/emails')).body.emails as Array<any>;
    for (const email of emails) await guest.call(`/api/emails/${email.id}/understand`, { method: 'POST' });
    assert.equal(app.ownerProviderCalls.count, 0);
    // And the sandbox's own provider is the recording, which has no network in it.
    const sandboxProvider = app.manager['sandboxes'].values().next().value?.provider;
    assert.equal(sandboxProvider?.name, 'replay');
    assert.ok((sandboxProvider?.asked ?? 0) >= 10);
    void createMockOutboundSender;
  } finally {
    await app.stop();
  }
});
