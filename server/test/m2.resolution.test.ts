import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseEmail,
  normaliseDomain,
  normalisePersonName,
  emailDomain,
  distinctiveTokens,
  trigramSimilarity,
} from '../src/agent/resolve/normalise.ts';
import {
  scoreContact,
  scoreCompany,
  applyThreadBonus,
  rankCandidates,
  SCORES,
  type ResolutionInput,
} from '../src/agent/resolve/score.ts';
import { decideOutcome } from '../src/agent/resolve/resolve.ts';
import { normaliseCompanyName } from '../src/domain/crm.ts';
import { RESOLUTION_THRESHOLDS, resolutionVerdict, type Candidate } from '../src/domain/resolution.ts';
import type { Company, Contact } from '../src/domain/crm.ts';

// M2 unit tests: normalisation, scoring, and the verdict rules.
//
// All pure functions — no database, no clock, no model. Written against the
// spec's scoring table (§7) so a change to a score or threshold fails here
// rather than silently changing which records get linked.

// ---------------------------------------------------------------- fixtures

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    companyId: 'company-1',
    fullName: 'Marcus Bell',
    email: 'marcus@solsticeretail.com',
    phone: null,
    jobTitle: null,
    lifecycle: 'customer',
    source: 'seed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function company(overrides: Partial<Company> = {}): Company {
  const name = overrides.name ?? 'Solstice Retail';
  return {
    id: 'company-1',
    name,
    nameNorm: overrides.nameNorm ?? normaliseCompanyName(name),
    domain: 'solsticeretail.com',
    website: null,
    industry: null,
    sizeBand: null,
    country: null,
    source: 'seed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    senderEmail: 'marcus@solsticeretail.com',
    senderName: 'Marcus Bell',
    extractedContactName: null,
    extractedContactEmail: null,
    extractedCompanyName: null,
    extractedCompanyDomain: null,
    threadId: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    entityType: 'company',
    entityId: 'c1',
    label: 'Some Company',
    score: 0.9,
    method: 'exact_domain',
    evidence: 'because reasons',
    signals: [],
    ...overrides,
  };
}

// =========================================================== normalisation

test('email normalisation lowercases and trims but preserves the local part', () => {
  assert.equal(normaliseEmail('  Marcus@SolsticeRetail.com '), 'marcus@solsticeretail.com');
  // Dots and +tags are NOT stripped: at many providers they are different
  // people, and merging two colleagues into one contact is unrecoverable.
  assert.notEqual(normaliseEmail('first.last@acme.com'), normaliseEmail('firstlast@acme.com'));
  assert.notEqual(normaliseEmail('jo+sales@acme.com'), normaliseEmail('jo@acme.com'));
});

test('domain extraction returns null rather than guessing', () => {
  assert.equal(emailDomain('Sarah@AcmeCommerce.io'), 'acmecommerce.io');
  assert.equal(emailDomain('not-an-email'), null);
  assert.equal(emailDomain('two@@at.com'), null);
});

test('domain normalisation strips protocol, www, port and path only', () => {
  assert.equal(normaliseDomain('https://www.Acme.com/contact'), 'acme.com');
  assert.equal(normaliseDomain('acme.com:8080'), 'acme.com');
  // Other subdomains are preserved: uk.acme.com and us.acme.com are routinely
  // different business units with different contacts.
  assert.equal(normaliseDomain('uk.acme.com'), 'uk.acme.com');
  assert.notEqual(normaliseDomain('uk.acme.com'), normaliseDomain('us.acme.com'));
  assert.equal(normaliseDomain('nonsense'), null);
});

test('person-name normalisation drops titles and suffixes, not identity', () => {
  assert.equal(normalisePersonName('Dr. Priya  Nair'), 'priya nair');
  assert.equal(normalisePersonName('Tom Reyes Jr.'), 'tom reyes');
  assert.equal(normalisePersonName('Renée Lévesque'), 'renee levesque');
  // Order is never sorted: plenty of real names are another name reversed.
  assert.notEqual(normalisePersonName('John Smith'), normalisePersonName('Smith John'));
  // Initials are not expanded: every J. Smith at a company is not one person.
  assert.notEqual(normalisePersonName('J Smith'), normalisePersonName('John Smith'));
});

test('a name that is only a title still keeps something', () => {
  assert.equal(normalisePersonName('Dr'), 'dr');
});

test('distinctive tokens exclude generic company words', () => {
  assert.deepEqual(distinctiveTokens('harborview digital'), ['harborview']);
  assert.deepEqual(distinctiveTokens('northline studio'), ['northline']);
  // Nothing identifying left at all.
  assert.deepEqual(distinctiveTokens('digital media group'), []);
});

test('trigram similarity behaves like pg_trgm', () => {
  assert.equal(trigramSimilarity('acme commerce', 'acme commerce'), 1);
  assert.equal(trigramSimilarity('', 'acme'), 0, 'two unknowns are not evidence of sameness');
  assert.ok(trigramSimilarity('northline studio', 'northline studios') > 0.8);
  assert.ok(trigramSimilarity('harborview group', 'harborview digital') < 0.5);
});

// ============================================ contact scoring (spec §7)

test('1. exact contact email match scores 1.00', () => {
  const scored = scoreContact(input(), contact());
  assert.ok(scored);
  assert.equal(scored.score, SCORES.contactExactEmail);
  assert.equal(scored.method, 'exact_email');
  assert.match(scored.evidence, /marcus@solsticeretail\.com/);
});

test('5. same domain plus an exact normalised name scores 0.85', () => {
  const scored = scoreContact(
    input({ senderEmail: 'm.bell@solsticeretail.com', extractedContactName: 'Dr Marcus Bell' }),
    contact(),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.contactDomainAndExactName);
  assert.equal(scored.method, 'domain_and_exact_name');
});

test('same domain plus a fuzzy name scores 0.70', () => {
  // "Marcus B Bell" vs "Marcus Bell" is 0.92 similar — above the 0.85 contact
  // threshold but not identical, which is exactly the middle rule.
  const scored = scoreContact(
    input({ senderEmail: 'marcus.b@solsticeretail.com', extractedContactName: 'Marcus B Bell' }),
    contact(),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.contactDomainAndFuzzyName);
  assert.equal(scored.method, 'domain_and_fuzzy_name');
});

test('7. the same name at a different domain is a weak candidate at 0.40', () => {
  const scored = scoreContact(
    input({ senderEmail: 'marcus@gmail.example', extractedContactName: 'Marcus Bell' }),
    contact(),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.contactNameOnly);
  // 0.40 is below the propose-create threshold, so it can never link.
  assert.ok(scored.score < RESOLUTION_THRESHOLDS.proposeCreate);
});

test('an unrelated contact produces no candidate at all', () => {
  const scored = scoreContact(
    input({ senderEmail: 'stranger@elsewhere.example', senderName: null }),
    contact(),
  );
  assert.equal(scored, null);
});

test('an extracted address can never redirect resolution away from the sender', () => {
  // A colleague named in the body — or an address planted by an injected
  // instruction — must not become the record we resolve onto.
  const scored = scoreContact(
    input({
      senderEmail: 'stranger@elsewhere.example',
      senderName: null,
      extractedContactEmail: 'marcus@solsticeretail.com',
    }),
    contact(),
  );
  assert.equal(scored, null, 'only the envelope sender may drive an email match');
});

// ============================================ company scoring (spec §7)

test('2. exact company domain match scores 1.00', () => {
  const scored = scoreCompany(input(), company());
  assert.ok(scored);
  assert.equal(scored.score, SCORES.companyExactDomain);
  assert.equal(scored.method, 'exact_domain');
});

test('an extracted domain also matches, even when the sender is elsewhere', () => {
  const scored = scoreCompany(
    input({ senderEmail: 'dana@gmail.example', extractedCompanyDomain: 'solsticeretail.com' }),
    company(),
  );
  assert.ok(scored);
  assert.equal(scored.method, 'exact_domain');
});

test('3+4. a normalised company-name match scores 0.80', () => {
  const scored = scoreCompany(
    input({ senderEmail: 'x@unknown.example', extractedCompanyName: 'Solstice Retail, Ltd.' }),
    company(),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.companyExactNameNorm);
  assert.equal(scored.method, 'exact_name_norm');
});

test('a fuzzy company name at or above 0.88 scores 0.65', () => {
  // 0.88 exactly — the boundary the spec names for company fuzzy matching.
  const scored = scoreCompany(
    input({ senderEmail: 'x@unknown.example', extractedCompanyName: 'Brightpath Recruitments' }),
    company({ id: 'company-2', name: 'Brightpath Recruitment', domain: 'brightpath.works' }),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.companyFuzzyName);
  assert.equal(scored.method, 'fuzzy_name');
});

test('a shared distinctive token scores 0.65 and can never auto-link alone', () => {
  const scored = scoreCompany(
    input({ senderEmail: 'mark@harborview-group.com', extractedCompanyName: 'Harborview Group' }),
    company({ id: 'company-3', name: 'Harborview Digital', domain: 'harborview.io' }),
  );
  assert.ok(scored);
  assert.equal(scored.score, SCORES.companyDistinctiveToken);
  assert.equal(scored.method, 'distinctive_token');
  assert.ok(scored.score < RESOLUTION_THRESHOLDS.autoLink, 'must land in the human-decision band');
});

test('sharing only a generic word is not evidence', () => {
  const scored = scoreCompany(
    input({ senderEmail: 'x@unknown.example', extractedCompanyName: 'Northline Digital' }),
    company({ id: 'company-4', name: 'Harborview Digital', domain: 'harborview.io' }),
  );
  assert.equal(scored, null, '"digital" is shared by half the industry');
});

// ================================================== thread bonus (spec §7)

test('the thread bonus adds 0.20 to an entity already linked in the thread', () => {
  const boosted = applyThreadBonus(candidate({ score: 0.65 }), new Set(['c1']));
  assert.equal(boosted.score, 0.85);
  assert.ok(boosted.signals.some((signal) => signal.method === 'thread'));
});

test('the thread bonus never pushes a score past an exact match', () => {
  const boosted = applyThreadBonus(candidate({ score: 1 }), new Set(['c1']));
  assert.equal(boosted.score, 1, 'seeing the thread before must not outrank the same address');
});

test('the thread bonus never invents a candidate', () => {
  const untouched = applyThreadBonus(candidate({ entityId: 'other' }), new Set(['c1']));
  assert.equal(untouched.score, 0.9);
  assert.equal(untouched.signals.length, 0);
});

// ====================================== verdict rules (FR-15, thresholds)

test('6. no candidates is NO_MATCH with a readable reason', () => {
  const result = decideOutcome('company', []);
  assert.equal(result.verdict, 'NO_MATCH');
  assert.equal(result.outcome, 'propose_create');
  assert.equal(result.selectedEntityId, null);
  assert.ok(result.reason.length > 20);
});

test('a candidate at or above 0.80 is a MATCH', () => {
  const result = decideOutcome('company', [candidate({ score: 0.8 })]);
  assert.equal(result.verdict, 'MATCH');
  assert.equal(result.outcome, 'auto_linked');
  assert.equal(result.selectedEntityId, 'c1');
});

test('11. a candidate below 0.50 is insufficient evidence, not a weak match', () => {
  const result = decideOutcome('contact', [candidate({ score: 0.4 })]);
  assert.equal(result.verdict, 'NO_MATCH');
  assert.match(result.reason, /too weak to link/);
});

test('7. a lone mid-band candidate is NOT promoted for lack of competition', () => {
  const result = decideOutcome('company', [candidate({ score: 0.65 })]);
  assert.equal(result.verdict, 'MATCH_CONFLICT');
  assert.equal(result.selectedEntityId, null, 'being the only candidate is not evidence');
});

test('9. two candidates within 0.10 are a conflict, never a match', () => {
  const result = decideOutcome('company', [
    candidate({ entityId: 'a', label: 'Harborview Digital', score: 0.65 }),
    candidate({ entityId: 'b', label: 'Harborview Media Ltd', score: 0.65 }),
  ]);
  assert.equal(result.verdict, 'MATCH_CONFLICT');
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.selectedEntityId, null);
  assert.match(result.reason, /Harborview Digital/);
  assert.match(result.reason, /Harborview Media Ltd/);
});

test('a close pair conflicts even when the leader clears the auto-link threshold', () => {
  // The tie is checked before the threshold: two equally good matches are a
  // question, not a match.
  const result = decideOutcome('contact', [
    candidate({ entityId: 'a', score: 1 }),
    candidate({ entityId: 'b', score: 0.95 }),
  ]);
  assert.equal(result.verdict, 'MATCH_CONFLICT');
  assert.equal(result.selectedEntityId, null);
});

test('8. a clear leader over a distant runner-up is still a MATCH', () => {
  const result = decideOutcome('company', [
    candidate({ entityId: 'a', score: 1 }),
    candidate({ entityId: 'b', score: 0.65 }),
  ]);
  assert.equal(result.verdict, 'MATCH');
  assert.equal(result.selectedEntityId, 'a');
});

test('ranking is stable across runs', () => {
  const ranked = rankCandidates([
    candidate({ entityId: 'z', score: 0.65 }),
    candidate({ entityId: 'a', score: 0.65 }),
    candidate({ entityId: 'm', score: 0.9 }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.entityId),
    ['m', 'a', 'z'],
  );
});

test('every verdict maps from exactly one stored outcome', () => {
  assert.equal(resolutionVerdict('auto_linked'), 'MATCH');
  assert.equal(resolutionVerdict('human_selected'), 'MATCH');
  assert.equal(resolutionVerdict('propose_create'), 'NO_MATCH');
  assert.equal(resolutionVerdict('conflict'), 'MATCH_CONFLICT');
});

test('every verdict carries an explanation an operator can read', () => {
  const cases = [
    decideOutcome('company', []),
    decideOutcome('company', [candidate({ score: 0.9 })]),
    decideOutcome('company', [candidate({ score: 0.4 })]),
    decideOutcome('company', [candidate({ entityId: 'a', score: 0.65 }), candidate({ entityId: 'b', score: 0.6 })]),
  ];
  for (const result of cases) {
    assert.ok(result.reason.length > 20, `reason too short: ${result.reason}`);
    assert.doesNotMatch(result.reason, /undefined|null|\[object/i);
  }
});
