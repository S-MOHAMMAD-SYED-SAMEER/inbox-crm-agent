import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, buildRationale, type DecisionContext } from '../src/agent/decide/rules.ts';
import { emptyExtraction, type Understanding } from '../src/domain/understanding.ts';
import { EMAIL_CATEGORIES, type EmailRecord, type EmailCategory } from '../src/domain/email.ts';
import type { EntityResolution } from '../src/domain/resolution.ts';

// W-1: once a person has chosen which record an ambiguous email is about, R-20 uses the choice.
// W-2: the articles and the claims in the reasons are right for every category.

const CONTACT_ID = 'contact-existing';
const COMPANY_ID = 'company-existing';

function understanding(category: EmailCategory, extracted: Record<string, string | null> = {}): Understanding {
  return {
    category,
    intent: 'Wants to talk about reporting work.',
    priority: 'medium',
    priorityReason: 'A direct question.',
    confidence: 0.9,
    confidenceBand: 'high',
    flags: { insufficientInformation: false, ambiguousIntent: category === 'ambiguous', possibleInjection: false },
    extracted: {
      ...emptyExtraction(),
      ...Object.fromEntries(
        Object.entries(extracted).map(([field, value]) => [field, { value, confidence: value === null ? 0 : 0.9, sourceSpan: value }]),
      ),
    } as Understanding['extracted'],
    questionAsked: null,
    summary: 'Wants to set up a call.',
  };
}

const noMatch = (entityType: 'contact' | 'company'): EntityResolution =>
  ({ entityType, verdict: 'NO_MATCH', outcome: 'propose_create', candidates: [], selectedEntityId: null, reason: 'x' }) as unknown as EntityResolution;

const picked = (entityType: 'contact' | 'company', id: string): EntityResolution =>
  ({ entityType, verdict: 'MATCH', outcome: 'human_selected', candidates: [], selectedEntityId: id, reason: 'x' }) as unknown as EntityResolution;

const autoMatched = (entityType: 'contact' | 'company', id: string): EntityResolution =>
  ({ entityType, verdict: 'MATCH', outcome: 'auto_linked', candidates: [], selectedEntityId: id, reason: 'x' }) as unknown as EntityResolution;

function context(category: EmailCategory, overrides: Partial<DecisionContext> = {}, extracted: Record<string, string | null> = {}): DecisionContext {
  return {
    email: {
      subject: 'Reporting work for Harborview',
      fromEmail: 'mark@harborview-group.invalid',
      fromName: 'Mark Doyle',
      bodyText: 'Hi, Mark Doyle from Harborview Group here. Could we talk reporting next week? 555-0100',
      providerMessageId: 'x',
    } as EmailRecord,
    understanding: understanding(category, extracted),
    contact: noMatch('contact'),
    company: noMatch('company'),
    openDeal: null,
    matchedContact: null,
    now: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

const VERIFIED = { contactName: 'Mark Doyle', companyName: 'Harborview Group', companyDomain: 'harborview-group.invalid', jobTitle: null, contactPhone: '555-0100' };

const typesOf = (ctx: DecisionContext): string[] => evaluateRules(ctx).actions.map((action) => action.type);
const find = (ctx: DecisionContext, type: string) => evaluateRules(ctx).actions.find((action) => action.type === type)?.payload as Record<string, any>;
const FORBIDDEN = ['create_deal', 'send_email', 'update_deal_stage'];

// ================================================================================ W-1

test('W-1 no pick (a plain Continue): the activity and the task are attached to the email only, even when the sender matches a record', () => {
  for (const ctx of [
    context('ambiguous', { humanChecked: true, humanPick: {} }, VERIFIED),
    // A machine match on a record is not a person's choice: still the email only.
    context('ambiguous', { humanChecked: true, humanPick: {}, contact: autoMatched('contact', CONTACT_ID), company: autoMatched('company', COMPANY_ID) }, VERIFIED),
  ]) {
    assert.deepEqual(typesOf(ctx).sort(), ['create_task', 'log_activity']);
    for (const type of ['log_activity', 'create_task']) {
      assert.equal(find(ctx, type)?.contact, null, `${type} contact`);
      assert.equal(find(ctx, type)?.company, null, `${type} company`);
    }
    for (const type of FORBIDDEN) assert.equal(typesOf(ctx).includes(type), false);
  }
  // Without the person's check there is still no plan at all.
  assert.deepEqual(typesOf(context('ambiguous', { humanChecked: false }, VERIFIED)), []);
});

test('W-1 an existing record picked: the activity and the task are attached to it, nothing is created, no link is added', () => {
  const ctx = context(
    'ambiguous',
    { humanChecked: true, humanPick: { company: 'existing' }, company: picked('company', COMPANY_ID) },
    VERIFIED,
  );
  assert.deepEqual(typesOf(ctx).sort(), ['create_task', 'log_activity']);
  for (const type of ['log_activity', 'create_task']) {
    assert.deepEqual(find(ctx, type)?.company, { kind: 'existing', id: COMPANY_ID });
    assert.equal(find(ctx, type)?.contact, null, 'the contact was not part of the choice');
  }
  for (const type of FORBIDDEN) assert.equal(typesOf(ctx).includes(type), false);

  // Both picked: both are used, and the two records are still not linked to each other (that was not what was chosen).
  const both = context(
    'ambiguous',
    { humanChecked: true, humanPick: { contact: 'existing', company: 'existing' }, contact: picked('contact', CONTACT_ID), company: picked('company', COMPANY_ID) },
    VERIFIED,
  );
  assert.deepEqual(typesOf(both).sort(), ['create_task', 'log_activity']);
  assert.deepEqual(find(both, 'log_activity')?.contact, { kind: 'existing', id: CONTACT_ID });
  assert.deepEqual(find(both, 'create_task')?.company, { kind: 'existing', id: COMPANY_ID });
  assert.match(evaluateRules(both).trace.find((entry) => entry.rule === 'R-20')?.because ?? '', /attached to the contact they picked and the company they picked/);
});

test('W-1 "create new records": the company and the contact are created from verified fields only, and the activity and the task are attached to them', () => {
  const ctx = context('ambiguous', { humanChecked: true, humanPick: { company: 'new' } }, VERIFIED);
  assert.deepEqual(typesOf(ctx).sort(), ['create_company', 'create_contact', 'create_task', 'log_activity']);

  // Only what passed the check, and the email's own headers: a field the check discarded (jobTitle) is null, not guessed.
  assert.deepEqual(find(ctx, 'create_company'), { name: 'Harborview Group', domain: 'harborview-group.invalid' });
  assert.deepEqual(find(ctx, 'create_contact'), {
    fullName: 'Mark Doyle',
    email: 'mark@harborview-group.invalid',
    jobTitle: null,
    phone: '555-0100',
    company: { kind: 'new', ref: 'company' },
  });
  for (const type of ['log_activity', 'create_task']) {
    assert.deepEqual(find(ctx, type)?.company, { kind: 'new', ref: 'company' });
    assert.deepEqual(find(ctx, type)?.contact, { kind: 'new', ref: 'contact' });
  }
  for (const type of FORBIDDEN) assert.equal(typesOf(ctx).includes(type), false);

  // A company name the check discarded is not invented from anywhere else: with no name and no domain nothing is created for it.
  const nameless = context('ambiguous', { humanChecked: true, humanPick: { company: 'new' } }, { ...VERIFIED, companyName: null, companyDomain: null });
  assert.equal(typesOf(nameless).includes('create_company'), false);
  assert.deepEqual(find(nameless, 'log_activity')?.company, null);

  // A record the CRM already has (the contact matched on its own) is not recreated, and is not attached either: nobody chose it.
  const matchedContact = context(
    'ambiguous',
    { humanChecked: true, humanPick: { company: 'new' }, contact: autoMatched('contact', CONTACT_ID) },
    VERIFIED,
  );
  assert.equal(typesOf(matchedContact).includes('create_contact'), false);
  assert.equal(find(matchedContact, 'log_activity')?.contact, null);
  assert.deepEqual(find(matchedContact, 'log_activity')?.company, { kind: 'new', ref: 'company' });
});

test('W-1 a pick changes nothing for any other category', () => {
  const sales = context('sales_inquiry', { humanChecked: true, humanPick: { company: 'existing' }, company: picked('company', COMPANY_ID) }, VERIFIED);
  const unpicked = context('sales_inquiry', { company: picked('company', COMPANY_ID) }, VERIFIED);
  assert.deepEqual(evaluateRules(sales).actions, evaluateRules(unpicked).actions);
});

// ================================================================================ W-2

test('W-2 "Read as" has the right article for every category, and none for "ambiguous" and "spam"', () => {
  const expected: Record<EmailCategory, string> = {
    sales_inquiry: 'a sales inquiry',
    service_inquiry: 'a service inquiry',
    pricing_request: 'a pricing request',
    support_request: 'a support request',
    follow_up: 'a follow up',
    partnership: 'a partnership',
    vendor_pitch: 'a vendor pitch',
    spam: 'spam',
    ambiguous: 'ambiguous',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...EMAIL_CATEGORIES].sort(), 'every category is covered');
  for (const category of EMAIL_CATEGORIES) {
    const ctx = context(category, category === 'ambiguous' ? { humanChecked: true, humanPick: {} } : {}, VERIFIED);
    const rationale = buildRationale(ctx, evaluateRules(ctx));
    assert.ok(rationale.startsWith(`Read as ${expected[category]} (high confidence).`), `${category}: ${rationale}`);
  }
});

test('W-2 no reason in any trace has a wrong article, for any category or any pick', () => {
  const contexts: DecisionContext[] = [];
  for (const category of EMAIL_CATEGORIES) {
    contexts.push(context(category, {}, VERIFIED), context(category, { humanChecked: true, humanPick: { company: 'new' } }, VERIFIED));
  }
  for (const ctx of contexts) {
    const text = evaluateRules(ctx).trace.map((entry) => entry.because).join(' | ');
    assert.doesNotMatch(text, /\ba [aeiou]/i, `"a" before a vowel: ${text}`);
    assert.doesNotMatch(text, /\ban [^aeiou\s]/i, `"an" before a consonant: ${text}`);
  }
});

test('W-2 R-01 and R-02 do not claim an ambiguous email "never" creates a record: it is true only when no person has chosen to', () => {
  const reason = (ctx: DecisionContext, rule: string): string => evaluateRules(ctx).trace.find((entry) => entry.rule === rule)?.because ?? '';

  const nobody = context('ambiguous', { humanChecked: true, humanPick: {} }, VERIFIED);
  assert.equal(reason(nobody, 'R-01'), 'an ambiguous email creates a company only when a person has chosen to create one, and no one has');
  assert.equal(reason(nobody, 'R-02'), 'an ambiguous email creates a contact only when a person has chosen to create one, and no one has');
  assert.doesNotMatch(reason(nobody, 'R-01'), /never/);

  const existing = context('ambiguous', { humanChecked: true, humanPick: { company: 'existing' }, company: picked('company', COMPANY_ID) }, VERIFIED);
  assert.equal(reason(existing, 'R-01'), 'a person picked an existing company, so a new one is not created');

  const created = context('ambiguous', { humanChecked: true, humanPick: { company: 'new' } }, VERIFIED);
  assert.equal(evaluateRules(created).trace.find((entry) => entry.rule === 'R-01')?.fired, true);
  assert.equal(evaluateRules(created).trace.find((entry) => entry.rule === 'R-02')?.fired, true);

  // Noise still never creates one, with the right article.
  assert.equal(reason(context('spam'), 'R-01'), 'a spam email never creates a CRM record');
  assert.equal(reason(context('vendor_pitch'), 'R-02'), 'a vendor pitch email never creates a CRM record');
});
