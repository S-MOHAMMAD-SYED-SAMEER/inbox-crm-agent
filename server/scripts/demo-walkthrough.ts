import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';

// `npm run demo:walkthrough`
//
// The whole product, driven the way a browser drives it: one real server, one
// cookie jar, real HTTP, real cookies, real CSRF. No component is stubbed and no
// check is performed against internals — every assertion below is made against
// what an operator would actually see.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A TEST
//
// The suite proves the pieces. This proves they compose into something you can
// put in front of a client, in order, without a step that quietly fails or a
// screen that says something untrue. It is also the rehearsal: run it before a
// demo and you know the machine is in the state you expect.
//
// It runs entirely on an in-memory database with the mock model provider, so it
// costs nothing, needs no credentials, and cannot send mail.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = path.join(SERVER_ROOT, 'data', 'demo');
const MIGRATIONS = path.join(SERVER_ROOT, 'migrations');

const PASSWORD = 'demo-walkthrough-operator-password';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function step(title: string): void {
  console.log(`\n${title}`);
}

// --- the browser -------------------------------------------------------------

type Reply = { status: number; body: any };

class Browser {
  private readonly jar = new Map<string, string>();
  private readonly baseUrl: string;

  // Plain assignment: this project runs TypeScript through Node's type
  // stripping, which forbids parameter properties.
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] as string;
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  get csrf(): string | null {
    const raw = this.jar.get('inbox_csrf');
    return raw ? decodeURIComponent(raw) : null;
  }

  get hasSession(): boolean {
    return this.jar.has('inbox_session');
  }

  /** The session cookie alone, for probing a request that omits CSRF. */
  sessionCookieHeader(): string {
    const value = this.jar.get('inbox_session');
    return value ? `inbox_session=${value}` : '';
  }

  /** Drops the session cookie without telling the server — a browser after expiry. */
  forgetSession(): void {
    this.jar.delete('inbox_session');
  }

  async call(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    const cookies = this.cookieHeader();
    if (cookies) headers.cookie = cookies;
    // Exactly what the web client does (M6-A).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && this.csrf) headers['x-csrf-token'] = this.csrf;

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    this.absorb(response);

    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  }
}

// --- boot --------------------------------------------------------------------

const db = createTestDatabase();
await runMigrations(db, MIGRATIONS, { now: () => '2026-01-01T00:00:00.000Z' });

const repos = createRepositories(db);
await seedDemoData(repos, readSeedFile(DEMO_DIR));

// Deliberately NOT setting the autonomy level here. The seed does it, and this
// walkthrough exists to prove the demo comes up right on its own — a script
// that configured the thing it then verified would prove only that the script
// works.

const config = {
  ...loadConfig({}).config,
  operatorPasswordHash: await hashPassword(PASSWORD),
  cookieSecure: false,
  demoDataDir: DEMO_DIR,
  migrationsDir: MIGRATIONS,
};

const app = createApp({ db, config, logger: createMemoryLogger().logger });
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = new Browser(baseUrl);

console.log('═══════════════════════════════════════════════════════════');
console.log(' INBOX-TO-CRM AGENT — DEMO WALKTHROUGH');
console.log(' Real server · real cookies · mock model · nothing is sent');
console.log('═══════════════════════════════════════════════════════════');

// ========================================================= 0. DEMO DEFAULTS
step('0. The demo comes up correctly from a plain seed');
{
  const settings = await repos.settings.getAll();
  check('the seeded demo runs at assisted autonomy', settings.autonomy_level === 'assisted', settings.autonomy_level);
  check('outbound sending is off in the seeded settings', settings.outbound_send_enabled === false);
  check('the approval window is 24 hours', settings.approval_sla_hours === 24);
}

// =============================================================== 1. SIGN IN
step('1. Sign in');
{
  const anonymous = await browser.call('/api/auth/session');
  check('an anonymous visitor is told they are not signed in', anonymous.status === 200 && anonymous.body.authenticated === false);

  const blocked = await browser.call('/api/emails');
  check('the inbox is refused before signing in', blocked.status === 401);

  const wrong = await browser.call('/api/auth/login', { method: 'POST', body: { password: 'not-it' } });
  check('a wrong password is refused', wrong.status === 401);
  check('and issues no session', !browser.hasSession);

  const login = await browser.call('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  check('the operator signs in', login.status === 200 && login.body.operator === 'operator');
  check('a session cookie is issued', browser.hasSession);
  check('a CSRF token is available to the page', browser.csrf !== null);

  const session = await browser.call('/api/auth/session');
  check('the app now reports an authenticated operator', session.body.authenticated === true && session.body.operator === 'operator');
}

// ============================================================ 2. THE INBOX
step('2. Ingest and open the inbox');
let heroId = '';
{
  const ingest = await browser.call('/api/emails/ingest', { method: 'POST', body: {} });
  check('ten demo emails arrive', ingest.status === 200 && ingest.body.ingested === 10, JSON.stringify(ingest.body));

  const again = await browser.call('/api/emails/ingest', { method: 'POST', body: {} });
  check('ingesting again adds nothing (duplicates are a no-op)', again.body.ingested === 0 && again.body.duplicates === 10);

  const inbox = await browser.call('/api/emails');
  check('the inbox lists them', inbox.status === 200 && inbox.body.emails.length === 10);

  const hero = inbox.body.emails.find((e: any) => e.subject.includes('Shopify AI chatbot'));
  check('the hero lead is present', Boolean(hero), 'demo-e01 not found');
  heroId = hero?.id ?? '';
}

// ========================================================== 3. THE PIPELINE
step('3. Understand → Resolve → Decide');
{
  await browser.call('/api/emails/understand', { method: 'POST', body: {} });
  await browser.call('/api/emails/resolve', { method: 'POST', body: {} });
  await browser.call('/api/emails/decide', { method: 'POST', body: {} });

  const detail = await browser.call(`/api/emails/${heroId}`);
  const d = detail.body;

  check('the email was read', d.analysis !== null && d.stages.understand === 'complete');
  check('it is classified as a sales enquiry', d.analysis?.understanding?.category === 'sales_inquiry');
  check('confidence is reported with a band', typeof d.analysis?.understanding?.confidence === 'number' && Boolean(d.analysis?.understanding?.confidenceBand));

  const extracted = d.analysis?.understanding?.extracted ?? {};
  const grounded = Object.values(extracted).filter((f: any) => f?.value !== null && typeof f?.sourceSpan === 'string' && f.sourceSpan.length > 0);
  check('every extracted field quotes the email it came from', grounded.length > 0, `grounded=${grounded.length}`);

  check('entity resolution ran', d.resolution !== null);
  check('a plan was produced', d.decision !== null && d.decision.plan.actions.length > 0);
  check('the plan is tier 2 and needs a human', d.decision?.plan.riskTier === 2 && d.decision?.plan.requiresApproval === true);
  check('the plan says WHY a human is needed', (d.decision?.plan.approvalReasons ?? []).length > 0);
  check('a reply was drafted', d.decision?.plan.draft !== null);
  check('the drafted reply passed the content checks', (d.decision?.plan.draft?.blockedBy ?? []).length === 0);
  check('the email is waiting for approval', d.email.state === 'awaiting_approval');
  check('nothing has been executed yet', d.executions.length === 0 && d.outbox === null);
  check('the decision is revision 1, produced by the assistant', d.decision?.revision === 1 && d.decision?.origin === 'agent');
}

// ============================================ 3b. THE UNATTENDED PATH (M6-E)
step('3b. What the assistant handled without anyone');
{
  // The other half of the story, and the half that was missing until M6-E.
  // Not everything needs a person: a tier-0 plan requires no approval under
  // `assisted` autonomy and now runs the moment it is decided, rather than
  // resting in `deciding` where it appeared in no queue and never finished.
  const inbox = await browser.call('/api/emails');
  const rows = inbox.body.emails ?? [];

  const stranded = rows.filter((row: any) => row.state === 'deciding');
  check('nothing was decided and then abandoned', stranded.length === 0, `deciding=${stranded.length}`);

  const settled = rows.filter((row: any) => row.state === 'completed' || row.state === 'archived');
  check('the assistant finished some on its own', settled.length > 0, `settled=${settled.length}`);

  // The support request: logged and a follow-up scheduled, no human involved.
  const support = rows.find((row: any) => row.subject?.includes('Checkout step failing'));
  check('the support email was handled end to end', support?.state === 'completed', `state=${support?.state}`);

  if (support) {
    const detail = await browser.call(`/api/emails/${support.id}`);
    const d = detail.body;
    check('its plan was tier 0 and needed no approval', d.decision?.plan.riskTier === 0 && d.decision?.plan.requiresApproval === false);
    check('no approval record was ever created for it', d.approval === null);
    check('and it really did the work', d.executions.filter((e: any) => e.status === 'succeeded').length > 0);
    check('nothing was sent on the unattended path', d.outbox === null);
  }

  // The spam: archived, with no CRM identity acquired along the way.
  const spam = rows.find((row: any) => row.subject?.includes('losing traffic'));
  check('the cold outreach was archived without a person', spam?.state === 'archived', `state=${spam?.state}`);
}

// ======================================================= 4. APPROVAL QUEUE
step('4. The approval queue');
let heroDecisionId = '';
{
  const queue = await browser.call('/api/approvals?state=pending');
  check('the queue loads', queue.status === 200);

  const row = queue.body.approvals.find((r: any) => r.email.id === heroId);
  check('the hero lead is in the queue', Boolean(row));
  check('the row shows who it is from and what is recommended', Boolean(row?.email.fromEmail) && Boolean(row?.recommendation));
  check('the row shows the risk tier and confidence', row?.riskTier === 2 && row?.confidenceBand !== null);
  check('it is actionable', row?.actionable === true);
  check('the queue reports counts for every state', Object.keys(queue.body.counts ?? {}).length === 5);

  heroDecisionId = row?.decision.id ?? '';
}

// ========================================================== 5. HUMAN EDIT
step('5. A person edits the drafted reply');
let revisedDecisionId = '';
{
  const before = await browser.call(`/api/emails/${heroId}`);
  const originalSubject = before.body.decision.plan.draft.subject;

  const revise = await browser.call(`/api/decisions/${heroDecisionId}/revise`, {
    method: 'POST',
    body: {
      edits: {
        draft: {
          subject: 'Thanks for getting in touch about your store',
          body: 'Hi Sarah,\n\nThanks for reaching out. When would suit you for a short call this week?\n\nSameer',
        },
      },
    },
  });

  check('the revision is accepted', revise.status === 201, JSON.stringify(revise.body?.error ?? {}));
  check('it is revision 2, edited by the signed-in operator', revise.body?.revision === 2 && revise.body?.decision.editedBy === 'operator');
  check('it records the decision it came from', revise.body?.parentDecisionId === heroDecisionId);
  check('the previous approval was replaced, not rejected', revise.body?.supersededApproval.state === 'superseded');
  check('the new version is waiting for approval', revise.body?.approval.state === 'pending');
  check('the change is shown as a before/after diff', Array.isArray(revise.body?.diff) && revise.body.diff.length > 0);

  revisedDecisionId = revise.body?.decision.id ?? '';

  const after = await browser.call(`/api/emails/${heroId}`);
  check('the history shows both versions', after.body.revisions?.length === 2);
  check('v1 is marked replaced and v2 is current', after.body.revisions?.[0]?.approvalState === 'superseded' && after.body.revisions?.[1]?.isCurrent === true);
  check('the original wording is preserved in history', originalSubject !== 'Thanks for getting in touch about your store');
  check('still nothing executed', after.body.executions.length === 0 && after.body.outbox === null);
}

// ====================================================== 6. APPROVE + EXECUTE
step('6. Approve the revised plan and let it run');
{
  const crmBefore = await browser.call('/api/emails');
  void crmBefore;

  const approve = await browser.call(`/api/decisions/${revisedDecisionId}/approve`, { method: 'POST', body: {} });
  check('approval succeeds and the plan runs', approve.status === 200 && approve.body.ok === true, approve.body?.refusalMessage ?? '');
  check('six actions were carried out', approve.body.executed === 6, `executed=${approve.body.executed}`);

  const detail = await browser.call(`/api/emails/${heroId}`);
  const d = detail.body;

  check('the email is complete', d.email.state === 'completed');
  check('execution records exist for every action', d.executions.length === 6);
  check('every action succeeded', d.executions.every((e: any) => e.status === 'succeeded'));
  check('created records carry a before/after snapshot', d.executions.filter((e: any) => e.actionType.startsWith('create_')).every((e: any) => e.beforeSnapshot === null && e.afterSnapshot !== null));

  check('a reply reached the outbox', d.outbox !== null);
  check('and was NOT sent — outbound is disabled', d.outbox?.status === 'suppressed' && d.outbox?.sentAt === null);
  check('the outbox says why', d.outbox?.suppressedReason === 'outbound_send_disabled');
  check('the human wording is what would go out', d.outbox?.subject === 'Thanks for getting in touch about your store');

  const types = (d.audit ?? []).map((e: any) => e.eventType);
  for (const expected of ['email_received', 'plan_created', 'plan_revised', 'approval_superseded', 'approval_granted', 'action_executed', 'outbox_suppressed']) {
    check(`the audit trail records ${expected}`, types.includes(expected));
  }
  check('the revision was recorded before the approval', types.indexOf('plan_revised') < types.indexOf('approval_granted'));
}

// ================================================== 7. CRM ACTUALLY CHANGED
step('7. The CRM actually changed');
{
  const counts = {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
    activities: await repos.activities.count(),
  };

  // Seed is 6/9/4/5/20. The hero plan a person approved adds one of each except
  // notes — and since M6-E the support email adds a task and an activity of its
  // own, because its plan is tier 0, needs no approval, and now runs as soon as
  // it is decided instead of resting in `deciding`.
  check('a company was created', counts.companies === 7, `companies=${counts.companies}`);
  check('a contact was created', counts.contacts === 10, `contacts=${counts.contacts}`);
  check('a deal entered the pipeline', counts.deals === 5, `deals=${counts.deals}`);
  check('a follow-up task was scheduled', counts.tasks === 7, `tasks=${counts.tasks}`);
  check('the email was logged on the timeline', counts.activities === 22, `activities=${counts.activities}`);

  const deal = (await repos.deals.list({ limit: 50 })).find((d) => d.title.includes('Acme'));
  check('the deal is named after the lead', Boolean(deal), 'no Acme deal found');
  check('the deal is marked as agent-created', deal?.source === 'agent');
}

// ============================================ 7b. THE CRM SCREENS (M6-C)
step('7b. Browsing the CRM the assistant just wrote to');
{
  // The screens a client clicks after the plan runs. Same endpoints the browser
  // calls, same session, same cookies.
  const deals = await browser.call('/api/deals');
  check('the Deals screen loads', deals.status === 200);

  const created = deals.body.deals.find((d: any) => (d.title ?? '').includes('Acme'));
  check('the deal the assistant just opened is listed', Boolean(created), 'no Acme deal in /api/deals');
  check('it is identifiable as created by the assistant', created?.source === 'agent');
  check('its company is resolved to a name', created?.companyName === 'Acme Commerce');
  check('its contact is resolved to a name and email', Boolean(created?.contactName) && Boolean(created?.contactEmail));
  check('its stage is shown', Boolean(created?.stage));

  const stageFiltered = await browser.call('/api/deals?stage=new_lead');
  check('the stage filter works', stageFiltered.status === 200 && stageFiltered.body.deals.every((d: any) => d.stage === 'new_lead'));

  const contacts = await browser.call('/api/contacts');
  check('the Contacts screen loads', contacts.status === 200);
  const contact = contacts.body.contacts.find((c: any) => (c.email ?? '').includes('acmecommerce'));
  check('the contact the assistant created is listed', Boolean(contact));
  check('it is identifiable as created by the assistant', contact?.source === 'agent');
  check('its company is resolved', contact?.companyName === 'Acme Commerce');
  check('its activity is counted', (contact?.activityCount ?? 0) >= 1);

  const companies = await browser.call('/api/companies');
  const company = companies.body.companies.find((c: any) => c.name === 'Acme Commerce');
  check('the Companies screen lists the new company', Boolean(company));
  check('with its contact and deal counts', company?.contactCount === 1 && company?.dealCount === 1);

  const tasks = await browser.call('/api/tasks?status=open');
  const task = tasks.body.tasks.find((t: any) => t.source === 'agent');
  check('the Tasks screen lists the follow-up', Boolean(task));
  check('with a due date and a linked record', Boolean(task?.dueAt) && Boolean(task?.contactName || task?.companyName));

  const audit = await browser.call('/api/audit');
  check('the Audit screen loads', audit.status === 200 && audit.body.events.length > 0);
  check('events carry an actor and an outcome', audit.body.events.every((e: any) => Boolean(e.actor) && Boolean(e.outcome)));
  check('the audit list carries no payload', audit.body.events.every((e: any) => e.payload === undefined));

  // Nothing on these screens may leak a message body. Checked against the real
  // stored bodies, not against the summaries — a subject legitimately appears in
  // an activity, a body never may.
  const serialised = JSON.stringify(audit.body);
  const storedEmails = await repos.emails.list({ limit: 50 });
  const bodyFragments = storedEmails
    .map((email) => email.bodyText.replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter((fragment) => fragment.length >= 30);

  check('there are real email bodies to check against', bodyFragments.length > 0, `fragments=${bodyFragments.length}`);
  const leaked = bodyFragments.filter((fragment) => serialised.includes(fragment));
  check('the audit list leaks no email body', leaked.length === 0, `${leaked.length} leaked`);

  // Refreshing does not lose them: a second read returns the same records.
  const again = await browser.call('/api/deals');
  check('a refresh returns the same records', again.body.deals.length === deals.body.deals.length && again.body.total === deals.body.total);

  // And they are read-only.
  const write = await browser.call('/api/deals', { method: 'POST', body: {} });
  check('there is no way to write a deal from the browser', write.status === 404);
}

// ==================================================== 8. IDEMPOTENT EXECUTION
step('8. Running it again changes nothing');
{
  const before = {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    outbox: await repos.outbox.count(),
  };

  const retry = await browser.call(`/api/decisions/${revisedDecisionId}/execute`, { method: 'POST', body: {} });
  check('a repeat execution is refused or is a no-op', retry.status === 200);

  const after = {
    companies: await repos.companies.count(),
    contacts: await repos.contacts.count(),
    deals: await repos.deals.count(),
    outbox: await repos.outbox.count(),
  };

  check('no duplicate company', after.companies === before.companies);
  check('no duplicate contact', after.contacts === before.contacts);
  check('no duplicate deal', after.deals === before.deals);
  check('no second outbox message', after.outbox === before.outbox);
  check('nothing was ever marked sent', (await repos.outbox.listByStatus('sent')).length === 0);
}

// ================================================== 9. PROMPT INJECTION (e10)
step('9. A customer email that tries to give the assistant orders');
{
  const inbox = await browser.call('/api/emails');
  const injection = inbox.body.emails.find((e: any) => e.subject.includes('Urgent order'));
  check('the injection email is present', Boolean(injection));

  const detail = await browser.call(`/api/emails/${injection.id}`);
  const d = detail.body;

  check('the attempt was detected', d.analysis?.understanding?.flags?.possibleInjection === true, JSON.stringify(d.analysis?.understanding?.flags ?? {}));
  check('it was routed to a human', d.email.state === 'needs_review');
  check('the review reason names the injection', d.email.reviewReason === 'possible_injection');
  check('no plan was produced', d.decision === null);
  check('nothing was written to the CRM', d.executions.length === 0);
  check('nothing reached the outbox', d.outbox === null);

  const types = (d.audit ?? []).map((e: any) => e.eventType);
  check('the attempt is on the record', types.includes('injection_suspected'));

  // The instruction embedded in the customer's email must not appear as an
  // action anywhere in the system.
  check('no action was created from the embedded instruction', d.decision === null && d.stages.decide !== 'complete');
}

// ============================================== 10. AN UNSAFE HUMAN EDIT
step('10. A person tries to put a price in a reply');
{
  // Take a fresh pending plan with a draft.
  const queue = await browser.call('/api/approvals?state=pending');
  const row = queue.body.approvals.find((r: any) => r.hasDraft === true);
  check('there is another drafted reply to edit', Boolean(row));

  const decisionId = row.decision.id;
  const emailId = row.email.id;

  const crmBefore = await repos.deals.count();
  const outboxBefore = await repos.outbox.count();

  const unsafe = await browser.call(`/api/decisions/${decisionId}/revise`, {
    method: 'POST',
    body: {
      edits: {
        draft: { body: 'Hi there,\n\nWe can do this for $2,000 and guarantee delivery within 2 weeks.\n\nSameer' },
      },
    },
  });

  check('the edit is refused', unsafe.status >= 400, `status=${unsafe.status}`);
  check('the refusal names the content checks', JSON.stringify(unsafe.body).includes('no_price_commitment'));

  const detail = await browser.call(`/api/emails/${emailId}`);
  check('no new version was created', detail.body.revisions?.length === 1);
  check('the original plan is untouched and still pending', detail.body.approval?.state === 'pending');
  check('no CRM change', (await repos.deals.count()) === crmBefore);
  check('nothing reached the outbox', (await repos.outbox.count()) === outboxBefore);

  const blocked = (detail.body.audit ?? []).find((e: any) => e.eventType === 'draft_edit_blocked');
  check('the attempt is audited', Boolean(blocked));
  check('the audit does not store the offending text', !JSON.stringify(blocked ?? {}).includes('$2,000'));
}

// ================================================== 11. APPROVAL EXPIRY
step('11. An approval nobody got to in time');
{
  const queue = await browser.call('/api/approvals?state=pending');
  const row = queue.body.approvals[0];
  check('there is a pending approval to expire', Boolean(row));

  // Age it past its window, exactly as the clock would.
  await db.execute('UPDATE approvals SET expires_at = ? WHERE decision_id = ?', [
    '2020-01-01T00:00:00.000Z',
    row.decision.id,
  ]);

  const sweep = await browser.call('/api/approvals/expire', { method: 'POST', body: {} });
  check('the sweep expires it', sweep.status === 200 && sweep.body.expired >= 1);

  const detail = await browser.call(`/api/emails/${row.email.id}`);
  check('the approval is now expired', detail.body.approval?.state === 'expired');
  check('the email went back for a human look', detail.body.email.state === 'needs_review');
  check('the reason is recorded', detail.body.email.reviewReason === 'approval_expired');

  const run = await browser.call(`/api/decisions/${row.decision.id}/execute`, { method: 'POST', body: {} });
  check('an expired approval cannot execute', run.body?.ok === false);
  check('and nothing was carried out', (await browser.call(`/api/emails/${row.email.id}`)).body.executions.length === 0);

  const types = (detail.body.audit ?? []).map((e: any) => e.eventType);
  check('the expiry is audited', types.includes('approval_expired'));
}

// ==================================================== 12. A REJECTED PLAN
step('12. A person rejects a plan');
{
  const queue = await browser.call('/api/approvals?state=pending');
  const row = queue.body.approvals[0];
  check('there is a pending approval to reject', Boolean(row));

  const reject = await browser.call(`/api/decisions/${row.decision.id}/reject`, {
    method: 'POST',
    body: { reason: 'Not a real lead — this is an existing supplier.' },
  });
  check('the rejection is accepted', reject.status === 200);

  const detail = await browser.call(`/api/emails/${row.email.id}`);
  check('the approval shows as rejected', detail.body.approval?.state === 'rejected');
  check('the reason is visible', (detail.body.approval?.reason ?? '').includes('existing supplier'));
  check('the email is marked rejected', detail.body.email.state === 'rejected');

  const run = await browser.call(`/api/decisions/${row.decision.id}/execute`, { method: 'POST', body: {} });
  check('a rejected plan cannot execute', run.body?.ok === false);
  check('and nothing was carried out', (await browser.call(`/api/emails/${row.email.id}`)).body.executions.length === 0);

  const rejectedQueue = await browser.call('/api/approvals?state=rejected');
  const listed = rejectedQueue.body.approvals.find((r: any) => r.email.id === row.email.id);
  check('it appears in the rejected queue', Boolean(listed));
  check('and is not offered as actionable', listed?.actionable === false);
}

// ==================================================== 13. SESSION BEHAVIOUR
step('13. Session behaviour');
{
  const csrfBefore = browser.csrf;

  // A mutation without the CSRF token is refused.
  const noCsrf = await fetch(`${baseUrl}/api/emails/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browser.sessionCookieHeader() },
    body: '{}',
  });
  check('a state-changing request without CSRF is refused', noCsrf.status === 403);
  check('the CSRF token is unchanged by the refusal', browser.csrf === csrfBefore);

  // An expired or revoked session sends the operator back to sign in.
  browser.forgetSession();
  const afterExpiry = await browser.call('/api/emails');
  check('a lost session refuses protected data', afterExpiry.status === 401);
  const session = await browser.call('/api/auth/session');
  check('and the app is told it is anonymous', session.body.authenticated === false);

  // Sign back in and out properly.
  await browser.call('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  check('signing back in works', browser.hasSession);

  const logout = await browser.call('/api/auth/logout', { method: 'POST', body: {} });
  check('logout succeeds', logout.status === 200 && logout.body.signedOut === true);
  check('the server cleared the session cookie', !browser.hasSession);
  check('protected data is refused again', (await browser.call('/api/emails')).status === 401);
}

// ==================================================== 14. OUTBOUND SAFETY
step('14. Outbound stays off');
{
  check('the demo configuration cannot send', config.allowOutboundSend === false && config.outboundProvider === 'none');
  check('no message was ever marked sent', (await repos.outbox.listByStatus('sent')).length === 0);

  const suppressed = await repos.outbox.listByStatus('suppressed');
  check('every queued reply is suppressed', suppressed.length > 0 && suppressed.every((m) => m.sentAt === null));
  check('and each says why', suppressed.every((m) => m.suppressedReason === 'outbound_send_disabled'));
}

// --- result ------------------------------------------------------------------

console.log('\n═══════════════════════════════════════════════════════════');
console.log(` RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n Failures:');
  for (const failure of failures) console.log(`   - ${failure}`);
}
console.log('═══════════════════════════════════════════════════════════\n');

server.close();
await db.close();
if (failed > 0) process.exitCode = 1;
