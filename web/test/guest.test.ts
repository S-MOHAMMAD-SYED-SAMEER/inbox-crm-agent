import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUEST_REANALYSE,
  NOT_IN_GUEST_DEMO,
  actorWho,
  bannerText,
  formatTimeLeft,
  guestAnalyseNote,
  guestStartError,
  resetNote,
  runLabel,
  showGuestButton,
  timeLeftMs,
  type GuestInfo,
} from '../src/auth/guest.ts';
import { currentCsrfToken, sessionFromResponse, isAuthenticated, GUEST_CSRF_COOKIE, CSRF_COOKIE } from '../src/auth/session.ts';

// The guest demo, as the browser sees it: the words, the countdown, who is shown as the actor, and who is offered the button.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const INFO: GuestInfo = {
  expiresAt: '2026-10-18T12:30:00.000Z',
  recordedAt: '2026-10-17',
  model: 'gemini-3.5-flash-lite',
  run: '1 of 3 (the first of three repeats of the ten-email evaluation)',
  idleMinutes: 30,
  maxMinutes: 120,
};

test('the banner says what the visitor is looking at, in the words that were agreed', () => {
  assert.equal(
    bannerText(INFO),
    'Guest demo — your changes are private and disappear when you leave. ' +
      'Model answers are replayed from a recorded real run of gemini-3.5-flash-lite (2026-10-17, 1 of 3 runs). ' +
      'Nothing is ever sent.',
  );
  assert.equal(runLabel('1 of 3 (the first of three repeats)'), '1 of 3 runs');
  assert.equal(runLabel('something else'), 'something else');
});

test('the time left is counted down in words, to the minute, and never goes below nothing', () => {
  const at = (minutes: number) => Date.parse('2026-10-18T12:30:00.000Z') - minutes * 60_000;
  assert.equal(timeLeftMs(INFO.expiresAt, at(27)), 27 * 60_000);
  assert.equal(timeLeftMs(INFO.expiresAt, at(-5)), 0, 'past the end is zero, not negative');
  assert.equal(timeLeftMs('not a date', 0), 0);
  assert.equal(formatTimeLeft(27 * 60_000), '27 min');
  assert.equal(formatTimeLeft(65 * 60_000), '1 h 5 min');
  assert.equal(formatTimeLeft(120 * 60_000), '2 h');
  assert.equal(formatTimeLeft(30_000), 'under a minute');
  assert.equal(resetNote(INFO, at(27)), 'Resets in 27 min if you stop (idle limit 30 min, longest 2 h).');
});

test('"Analyse again" says it replays the same recorded answer, and the cost note says no model is called', () => {
  assert.equal(GUEST_REANALYSE, 'Analyse again (replays the same recorded answer)');
  assert.equal(guestAnalyseNote(10), 'Reads all 10 waiting emails in one go, using the recorded answers. No model is called.');
  assert.equal(guestAnalyseNote(0), null);
  assert.equal(NOT_IN_GUEST_DEMO, 'Not available in the guest demo');
});

test('the guest entry is offered to a visitor only, and only when the server has the demo on', () => {
  assert.equal(showGuestButton('anonymous', true), true);
  assert.equal(showGuestButton('anonymous', false), false, 'GUEST_DEMO=false');
  assert.equal(showGuestButton('authenticated', true), false, 'a signed-in owner is never offered it');
  assert.equal(showGuestButton('loading', true), false);
  assert.equal(showGuestButton('public-demo', true), false);
});

test('a guest is a guest only when the server says so and describes the session; the owner\'s shape is untouched', () => {
  const owner = sessionFromResponse({ authenticated: true, operator: 'operator', expiresAt: '2026-06-01T12:00:00.000Z', role: 'owner' });
  assert.deepEqual(owner, { status: 'authenticated', operator: 'operator', expiresAt: '2026-06-01T12:00:00.000Z' });

  const guest = sessionFromResponse({ authenticated: true, operator: 'guest', role: 'guest', expiresAt: INFO.expiresAt, guest: INFO });
  assert.deepEqual(guest, { status: 'authenticated', operator: 'guest', expiresAt: INFO.expiresAt, role: 'guest', guest: INFO });
  assert.equal(isAuthenticated(guest), true);

  // Claiming the role without the description is not a half-guest: it reads as the plain shape, with no guest information at all.
  const claim = sessionFromResponse({ authenticated: true, operator: 'guest', role: 'guest', expiresAt: INFO.expiresAt });
  assert.equal('guest' in claim && claim.guest !== undefined, false);
  assert.equal('role' in claim && claim.role === 'guest', false);
});

test('the browser sends the guest\'s CSRF token when there is one, and the owner\'s first if it somehow holds both', () => {
  const original = (globalThis as { document?: unknown }).document;
  const set = (cookie: string) => {
    (globalThis as { document?: unknown }).document = { cookie };
  };
  try {
    set(`${GUEST_CSRF_COOKIE}=guest-token`);
    assert.equal(currentCsrfToken(), 'guest-token');
    set(`${CSRF_COOKIE}=owner-token; ${GUEST_CSRF_COOKIE}=guest-token`);
    assert.equal(currentCsrfToken(), 'owner-token');
    set('other=1');
    assert.equal(currentCsrfToken(), null);
  } finally {
    (globalThis as { document?: unknown }).document = original;
  }
});

test('a person actor with the id guest is shown as "Guest"', () => {
  assert.equal(actorWho('human', 'guest'), 'Guest');
  assert.equal(actorWho('human', 'operator'), 'Person · operator');
  assert.equal(actorWho('human', null), 'Person');
  assert.equal(actorWho('ai', 'gemini'), 'Assistant');
  assert.equal(actorWho('system', null), 'System');
});

test('each way the demo can fail to start is said plainly', () => {
  assert.equal(guestStartError(503, 'The demo is busy — try again in a few minutes.'), 'The demo is busy — try again in a few minutes.');
  assert.match(guestStartError(429, null), /Too many demo sessions/);
  assert.match(guestStartError(409, null), /signed in as the owner/);
  assert.match(guestStartError(403, null), /turned off/);
  assert.match(guestStartError(0, null), /Could not start the demo/);
});

test('the screens are wired to the guest pieces: banner, disabled owner-only sections, entry button, replay wording', () => {
  const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
  const shell = read('components/AppShell.tsx');
  assert.match(shell, /<GuestBanner/);
  assert.match(shell, /aria-disabled="true"/);
  assert.match(shell, /NOT_IN_GUEST_DEMO/);
  assert.match(shell, /OWNER_ONLY = new Set<RouteName>\(\['automation', 'settings'\]\)/);
  const login = read('screens/Login.tsx');
  assert.match(login, /Try the demo — no sign-in/);
  assert.match(login, /guestDemoEnabled && onTryDemo/);
  assert.match(read('components/guestBanner.tsx'), /Start over/);
  assert.match(read('screens/EmailDetail.tsx'), /GUEST_REANALYSE/);
  // The owner's sign-in code is not touched by any of it: the password path is the same call it always was.
  assert.match(read('api/client.ts'), /login: \(password: string\)/);
  assert.match(read('screens/Login.tsx'), /api\.login\(password\)/);
});
