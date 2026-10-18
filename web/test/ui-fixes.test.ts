import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDefence } from '../src/security/injectionPresentation.ts';
import {
  PAUSED_FOR_PERSON,
  analyseButtonLabel,
  analyseCostNote,
  codeOverrideNote,
  countLabel,
  crmMatchLabel,
  cutAtWord,
  formatLatency,
  formatMoment,
  isPaused,
  mentionsDiscardedMarker,
  noContinueReason,
  outcomeFor,
  reviewActionsFor,
  sentenceCase,
} from '../src/inbox/copy.ts';
import { eventLabel } from '../src/crm/presentation.ts';

// The UI fixes from the live browser review, as pure functions and as wording that is pinned so it cannot quietly drift back.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// -------------------------------------------------------------- U-1: the honest sentence

test('U-1: the injection defence says the check runs on every email, separately from the AI, and that its verdict overrides the AI', () => {
  const flagged = describeDefence(true).detail;
  const notFlagged = describeDefence(false).detail;
  assert.equal(flagged, "This check runs on every email, separately from the AI, and its verdict overrides the AI's. Here the AI flagged it as well.");
  assert.equal(notFlagged, "This check runs on every email, separately from the AI, and its verdict overrides the AI's. It does not depend on the AI noticing, as here, where it did not.");
});

test('U-1: nothing in the web app says the check runs before the AI or the model', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const offenders: string[] = [];
  const claim = /runs\s+before\s+the\s+(?:AI|model)|before\s+the\s+(?:AI|model)(?:'s|\u2019s)?\s+(?:is\s+asked|opinion)|before\s+(?:the\s+)?(?:AI|model)\s+is\s+(?:consulted|asked)/i;
  for (const file of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
    if (claim.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], 'a screen or comment still says the check runs before the AI');
});

// ------------------------------------------------------------------- U-2: what a person can do

test('U-2: archive for anything handed to a person; continue only for an ambiguous reading; nothing for any other state', () => {
  assert.deepEqual(reviewActionsFor('needs_review', 'ambiguous_intent'), ['archive', 'continue']);
  assert.deepEqual(reviewActionsFor('needs_review', 'possible_injection'), ['archive']);
  assert.deepEqual(reviewActionsFor('needs_review', 'match_conflict'), ['archive']);
  assert.deepEqual(reviewActionsFor('needs_review', null), ['archive']);
  assert.deepEqual(reviewActionsFor('awaiting_approval', null), []);
  assert.match(noContinueReason('possible_injection') ?? '', /can only be archived/);
  assert.equal(noContinueReason('ambiguous_intent'), null);
});

// ----------------------------------------------------------- U-3 and U-4: markers and the override

test('U-3: the marker names the discarded value and says nothing when there is none', () => {
  assert.equal(mentionsDiscardedMarker(undefined), null);
  assert.equal(mentionsDiscardedMarker([]), null);
  assert.equal(mentionsDiscardedMarker([{ claimedValue: 'Acme Commerce' }]), 'Mentions a discarded value: \u201cAcme Commerce\u201d');
});

test('U-4: when code changed the category the number is said to be the model\'s, for the category it gave', () => {
  assert.equal(codeOverrideNote('follow_up', 0.8), 'model 0.80 for follow up');
  assert.equal(codeOverrideNote(null, 0.8), null);
});

// --------------------------------------------------------------------------------- U-5

test('U-5: a NO_MATCH is a "new record" only when the plan creates it', () => {
  assert.equal(crmMatchLabel('NO_MATCH', true), 'New record');
  assert.equal(crmMatchLabel('NO_MATCH', null), 'New record', 'before a plan exists nothing says otherwise');
  assert.equal(crmMatchLabel('NO_MATCH', false), 'No match');
  assert.equal(crmMatchLabel('MATCH', false), 'Matched');
  assert.equal(crmMatchLabel('MATCH_CONFLICT', false), 'Needs a decision');
});

test('U-5: a paused email says it is paused for a person, not that it is queued', () => {
  assert.equal(PAUSED_FOR_PERSON, 'Paused \u2014 waiting for a person');
  assert.equal(isPaused('needs_review'), true);
  assert.equal(isPaused('received'), false);
  assert.equal(isPaused('resolving'), false);
});

test('U-5: an approval that is waiting is "held for approval", not blocked or stopped; real stops keep their words', () => {
  assert.equal(outcomeFor('approval_requested', 'blocked').label, 'Held for approval');
  assert.equal(outcomeFor('policy_evaluated', 'blocked').label, 'Held for approval');
  assert.equal(outcomeFor('injection_suspected', 'blocked').label, 'Stopped');
  assert.equal(outcomeFor('draft_blocked', 'blocked').label, 'Stopped');
  assert.equal(outcomeFor('action_failed', 'failed').label, 'Failed');
  assert.equal(outcomeFor('plan_created', 'ok').label, 'Done');
});

test('U-5: the analyse button says how many emails it will read, and the note says what that costs', () => {
  assert.equal(analyseButtonLabel(10), 'Analyse waiting emails (10)');
  assert.equal(analyseButtonLabel(1), 'Analyse waiting email (1)');
  assert.equal(analyseButtonLabel(0), 'Analyse waiting emails (0)');
  assert.equal(analyseCostNote(10), 'Reads all 10 waiting emails in one go: 10 model requests with a real model.');
  assert.equal(analyseCostNote(1), 'Reads the 1 waiting email in one go: one model request with a real model.');
  assert.equal(analyseCostNote(0), null);
});

// --------------------------------------------------------------------------------- U-6

test('U-6: plurals, latency, moments and sentences', () => {
  assert.equal(countLabel(1, 'action'), '1 action');
  assert.equal(countLabel(3, 'action'), '3 actions');
  assert.equal(countLabel(0, 'action'), '0 actions');
  assert.equal(formatLatency(2191.5875000000233), '2.2 s');
  assert.equal(formatLatency(420.4), '420 ms');
  assert.equal(formatLatency(null), '\u2014');
  assert.equal(formatLatency(0), '0 ms');
  assert.doesNotMatch(formatMoment('2026-09-01T09:07:33.000Z'), /:\d\d:\d\d/, 'no seconds');
  assert.equal(formatMoment('not a date'), 'not a date');
  assert.equal(sentenceCase('a vendor pitch never becomes a lead'), 'A vendor pitch never becomes a lead');
  assert.equal(sentenceCase(''), '');
});

test('U-6: text is cut at a whole word with an ellipsis, and short text is left alone', () => {
  const note = 'Partnership approach: White-label partnership where Meridian Craft brings the technical side of automation projects to us';
  const { shown, cut } = cutAtWord(note, 90);
  assert.equal(cut, true);
  assert.match(shown, /\u2026$/);
  const withoutEllipsis = shown.slice(0, -1);
  assert.ok(note.startsWith(withoutEllipsis), 'what is shown is a prefix of the whole');
  assert.ok(/\s/.test(note.charAt(withoutEllipsis.length)), 'the cut falls on a word boundary, never mid-word');
  assert.deepEqual(cutAtWord('short', 90), { shown: 'short', cut: false });
});

// --------------------------------------------------------------------------------- audit

test('the new audit events have plain labels, and unknown ones still degrade to readable text', () => {
  assert.equal(eventLabel('human_review_recorded'), 'Decided by a person');
  assert.equal(eventLabel('category_changed_by_code'), 'Category changed by a rule');
  assert.equal(eventLabel('summary_mentions_discarded_value'), 'Summary mentions a discarded detail');
  assert.equal(eventLabel('something_new_later'), 'something new later');
});

// ----------------------------------------------------------- the screens use the helpers

test('the screens are wired to the helpers: the pinned behaviours reach the user, not just the module', () => {
  const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
  const inbox = read('screens/Inbox.tsx');
  assert.match(inbox, /analyseButtonLabel\(waiting\)/);
  assert.match(inbox, /href=\{routeToHash\(\{ name: 'inbox', id: email\.id \}\)\}[\s\S]*?\{email\.subject\}/, 'the subject is a link');
  assert.match(inbox, /plannedToCreate=/);
  assert.match(inbox, /PAUSED_FOR_PERSON/);
  const detail = read('screens/EmailDetail.tsx');
  assert.match(detail, /api\.reviewEmail\(id, action\)/);
  assert.match(detail, /formatLatency\(analysis\.latencyMs\)/);
  assert.match(detail, /outcomeFor\(event\.eventType, event\.outcome\)/);
  assert.match(read('screens/Approvals.tsx'), /NeedsPersonList/);
  assert.match(read('screens/Crm.tsx'), /event\.email\.subject/);
  assert.match(read('components/planDiff.tsx'), /formatMoment\(/);
});
