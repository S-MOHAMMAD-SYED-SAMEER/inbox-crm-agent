import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemFacts } from '../src/system/statusPresentation.ts';
import type { GuestInfo } from '../src/auth/guest.ts';
import type { Health } from '../src/api/types.ts';
import {
  CHOOSE_THE_RECORD,
  NONE_OF_THESE,
  approvalTimeLabel,
  approvedMessage,
  canChooseRecord,
  continueResultMessage,
  formatDuration,
  pickResultMessage,
} from '../src/inbox/copy.ts';
import { budgetQuote } from '../src/crm/presentation.ts';

// The second round of UI fixes: the guest's status cards, choosing the record, small wording, the phone layout and the guest controls.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

const GUEST: GuestInfo = {
  expiresAt: '2026-10-18T12:30:00.000Z',
  recordedAt: '2026-10-17',
  model: 'gemini-3.5-flash-lite',
  run: '1 of 3 (the first of three repeats of the ten-email evaluation)',
  idleMinutes: 30,
  maxMinutes: 120,
};

// The server a guest is talking to may well have a real key, sign-in and sending configured. That is the owner's world, and it must not
// leak into what a guest is told.
const OWNER_SERVER: Health = {
  status: 'ok',
  database: { driver: 'sqlite', reachable: true, migrationsApplied: 10 },
  adapters: {
    llmProvider: 'anthropic',
    llmConfigured: true,
    emailSource: 'demo',
    crmTarget: 'local',
    database: 'sqlite',
    outboundSendEnabled: true,
    authConfigured: true,
    cookieSecure: true,
    autonomyLevel: 'manual',
  },
  version: '1.0.0',
};

const card = (facts: ReturnType<typeof systemFacts>, label: string) => facts.find((fact) => fact.label === label);

// ============================================================== V-1: the guest's Overview says what is true of the guest

test('V-1 language model: a guest is told it is a replay of the recorded run; the owner is told what the server uses', () => {
  const guest = card(systemFacts(OWNER_SERVER, GUEST), 'Language model');
  assert.equal(guest?.detail, 'Replay of a recorded real run of gemini-3.5-flash-lite (2026-10-17). No live model calls.');
  assert.doesNotMatch(`${guest?.value} ${guest?.detail}`, /Live model calls|every reply checked|Claude/);

  const owner = card(systemFacts(OWNER_SERVER, null), 'Language model');
  assert.equal(owner?.value, 'Claude');
  assert.equal(owner?.detail, 'Live model calls, with every reply checked before it can be used.');
  // Leaving the argument out is the owner's view, exactly as before.
  assert.deepEqual(systemFacts(OWNER_SERVER), systemFacts(OWNER_SERVER, null));
});

test('V-1 sign-in: a guest is told there is no sign-in and a private sandbox; the owner is told every screen requires one', () => {
  assert.equal(card(systemFacts(OWNER_SERVER, GUEST), 'Sign-in')?.detail, 'Guest demo. No sign-in, private sandbox.');
  assert.doesNotMatch(card(systemFacts(OWNER_SERVER, GUEST), 'Sign-in')?.detail ?? '', /requires a signed-in operator/);

  const owner = card(systemFacts(OWNER_SERVER, null), 'Sign-in');
  assert.equal(owner?.value, 'Required');
  assert.equal(owner?.detail, 'Every screen and every action requires a signed-in operator.');
});

test('V-1 sending: a guest is told it is always off; the owner is told what the server does, whichever way it is set', () => {
  const guestOnServerWithSendingOn = card(systemFacts(OWNER_SERVER, GUEST), 'Sending replies');
  assert.equal(guestOnServerWithSendingOn?.value, 'Off');
  assert.equal(guestOnServerWithSendingOn?.detail, 'Always off in the guest demo.');
  assert.equal(guestOnServerWithSendingOn?.tone, 'good');
  // Even when the server has sending ON, the guest is never told anything but off: its sender refuses.
  assert.doesNotMatch(guestOnServerWithSendingOn?.detail ?? '', /until sending is turned on|delivered/);

  const ownerOn = card(systemFacts(OWNER_SERVER, null), 'Sending replies');
  assert.equal(ownerOn?.value, 'On');
  assert.equal(ownerOn?.detail, 'Approved replies are delivered to the recipient.');
  const ownerOff = card(systemFacts({ ...OWNER_SERVER, adapters: { ...OWNER_SERVER.adapters, outboundSendEnabled: false } }, null), 'Sending replies');
  assert.equal(ownerOff?.value, 'Off');
  assert.match(ownerOff?.detail ?? '', /Nothing reaches a customer until sending is turned on/);
});

test('V-1: the other cards, and their order, are the same for a guest and the owner', () => {
  const labels = (facts: ReturnType<typeof systemFacts>) => facts.map((fact) => fact.label);
  assert.deepEqual(labels(systemFacts(OWNER_SERVER, GUEST)), labels(systemFacts(OWNER_SERVER, null)));
  assert.deepEqual(card(systemFacts(OWNER_SERVER, GUEST), 'CRM'), card(systemFacts(OWNER_SERVER, null), 'CRM'));
  assert.equal(read('screens/Overview.tsx').includes('systemFacts(state.health, guest)'), true, 'the Overview passes the guest session in');
});

// ============================================================ V-2: choosing the record

test('V-2: "Choose the record" is offered for a match conflict, and for nothing else', () => {
  assert.equal(canChooseRecord('needs_review', 'match_conflict'), true);
  for (const reason of ['ambiguous_intent', 'possible_injection', 'low_confidence', null]) {
    assert.equal(canChooseRecord('needs_review', reason), false, String(reason));
  }
  assert.equal(canChooseRecord('awaiting_approval', 'match_conflict'), false);
  assert.equal(CHOOSE_THE_RECORD, 'Choose the record');
  assert.equal(NONE_OF_THESE, 'None of these — create new records');
});

test('V-2: what Continue did is said, including "choose one", and what a pick did is said too', () => {
  assert.equal(
    continueResultMessage('needs_review', 'match_conflict'),
    'Continued. CRM matching found more than one possible record; choose one.',
  );
  assert.match(continueResultMessage('awaiting_approval', null), /^Continued\. .*waiting for approval/);
  assert.match(continueResultMessage('needs_review', 'possible_injection'), /still needs a person/);

  assert.equal(pickResultMessage('awaiting_approval', null, false), 'Record chosen. The plan is waiting for approval.');
  assert.equal(pickResultMessage('awaiting_approval', null, true), 'Recorded: new records will be proposed. The plan is waiting for approval.');
  assert.match(pickResultMessage('needs_review', 'match_conflict', false), /still needs choosing/);
});

test('V-2: the choice is offered where people look (the list and the email), and the result is not thrown away by the next message', () => {
  const list = read('components/needsPerson.tsx');
  assert.match(list, /canChooseRecord\(email\.state, email\.reviewReason\)/);
  assert.match(list, /<ChooseRecord/);
  assert.match(list, /api\.resolveMatch/);
  // The result of Continue is kept beside its own email, apart from the one message the next action replaces.
  assert.match(list, /setNotes\(/);
  assert.match(list, /data-row-note/);

  const detail = read('screens/EmailDetail.tsx');
  assert.match(detail, /<ChooseRecord/);
  assert.match(detail, /continueResultMessage\(/);
  assert.match(detail, /data-result-note/);
  // A refusal from the server is said where the choice is; it does not replace the page.
  assert.doesNotMatch(detail.slice(detail.indexOf('const chooseMatch'), detail.indexOf('const review =')), /status: 'error'/);
});

// ================================================================== V-4: the phone

test('V-4: below 768px the sections are behind a menu button, and the sidebar is unchanged from 768px', () => {
  const shell = read('components/AppShell.tsx');
  assert.match(shell, /data-menu-button/);
  assert.match(shell, /aria-expanded=\{menuOpen\}/);
  assert.match(shell, /md:hidden/);
  assert.match(shell, /\$\{menuOpen \? 'block' : 'hidden'\} .*md:block/);
  assert.match(shell, /setMenuOpen\(false\)/, 'choosing a section closes the menu');
});

test('V-4: the guest banner is one line on a phone, with the whole text behind Details, and both controls stay reachable', () => {
  const banner = read('components/guestBanner.tsx');
  assert.match(banner, /data-guest-details/);
  assert.match(banner, /Guest demo · nothing is sent/);
  assert.match(banner, /data-guest-start-over/);
  assert.match(banner, /data-guest-leave aria-label="Leave the demo"/);
  assert.match(banner, /bannerText\(info\)/);
});

// ============================================================ V-5: small fixes

test('V-5: "Approved and carried out 1 action" / "3 actions", never "action(s)"', () => {
  assert.equal(approvedMessage(3), 'Approved and carried out 3 actions.');
  assert.equal(approvedMessage(1), 'Approved and carried out 1 action.');
  assert.equal(approvedMessage(0), 'Approved and carried out 0 actions.');
  assert.doesNotMatch(read('screens/Approvals.tsx'), /action\(s\)/);
});

test('V-5: no quote is shown when the email gave no budget words', () => {
  assert.equal(budgetQuote('not_provided'), null);
  assert.equal(budgetQuote('Not provided'), null);
  assert.equal(budgetQuote('  '), null);
  assert.equal(budgetQuote(null), null);
  assert.equal(budgetQuote('around $5k'), 'around $5k');
  assert.match(read('screens/Crm.tsx'), /budgetQuote\(deal\.budgetNote\)/);
});

test('V-5: an approval timer promises a day to the owner and only what the sandbox has to a guest', () => {
  const day = 24 * 3_600_000 - 60_000;
  const now = Date.parse('2026-10-18T11:00:00.000Z');
  assert.equal(approvalTimeLabel(day, null, now), '23h 59m left');
  assert.equal(approvalTimeLabel(-5 * 60_000, null, now), '5m overdue');
  // 90 minutes of sandbox left: never "23h 59m left".
  assert.equal(approvalTimeLabel(day, GUEST, now), 'Demo ends in 1 h 30 min');
  assert.doesNotMatch(approvalTimeLabel(day, GUEST, now), /23h/);
  assert.equal(formatDuration(day), '23h 59m');
});

test('V-5: Start over asks first, and Leave the demo goes to the sign-in page at the site address', () => {
  const banner = read('components/guestBanner.tsx');
  assert.match(banner, /Start over\? Your changes in this demo will be lost\./);
  assert.match(banner, /onClick=\{\(\) => setConfirming\(true\)\}/, 'the first click only asks');
  assert.match(banner, /data-guest-confirm-yes/);
  // The reset call is made only from the confirm button.
  assert.equal((banner.match(/^\s+onStartOver\(\);/gm) ?? []).length, 1);

  const session = read('auth/useSession.ts');
  const leave = session.slice(session.indexOf('const leaveGuest'));
  assert.match(leave, /history\.replaceState\(null, '', window\.location\.pathname\)/, 'the hash is dropped');
});

// ============================================================ V-3: the Inbox table

test('V-3: the Inbox table fits at 1280px — narrow From, a wide Subject, Confidence folded into Read as below 1440px, pills on one line', () => {
  const inbox = read('screens/Inbox.tsx');
  assert.doesNotMatch(inbox, /min-w-\[860px\]/);
  assert.match(inbox, /min-w-\[260px\]/);
  // The address sits under the name, truncated, with the whole of it on hover.
  assert.match(inbox, /title=\{email\.fromEmail\}/);
  assert.match(inbox, /truncate/);
  // The Confidence column exists from 1440px; below that the same badge is inside Read as.
  assert.match(inbox, /hidden px-2 py-3 font-semibold min-\[1440px\]:table-cell">Confidence/);
  assert.match(inbox, /<span className="min-\[1440px\]:hidden">\s*<ConfidenceBadge/);
  for (const file of ['components/understanding.tsx', 'components/resolution.tsx']) {
    assert.match(read(file), /whitespace-nowrap rounded-pill/, `${file} pills wrap`);
  }
});
