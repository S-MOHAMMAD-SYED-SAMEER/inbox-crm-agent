import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionStatus, systemFacts } from '../src/system/statusPresentation.ts';
import { describeDefence } from '../src/security/injectionPresentation.ts';
import { reviewReasonLabel, stateLabel } from '../src/inbox/statePresentation.ts';
import type { Health } from '../src/api/types.ts';

// M6-E — the demo polish pass.
//
// Everything here answers one question: would a client, watching this for ten
// minutes, see something that reads as unfinished, internal, or untrue?
//
// The findings this pass fixes were all *rendered text*, which is exactly the
// category no test was watching. The source scan at the bottom is the part that
// stops them coming back.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Source with comments removed — a comment may say anything, screens may not. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, '/');

// --- system status presentation ---------------------------------------------

const HEALTH: Health = {
  status: 'ok',
  database: { driver: 'sqlite', reachable: true, migrationsApplied: 10 },
  adapters: {
    llmProvider: 'mock',
    llmConfigured: true,
    emailSource: 'demo',
    crmTarget: 'local',
    database: 'sqlite',
    outboundSendEnabled: false,
    authConfigured: true,
    cookieSecure: true,
    autonomyLevel: 'manual',
  },
  version: '1.0.0',
};

test('system status reads as a sentence, not a key/value dump', () => {
  const facts = [connectionStatus(HEALTH), ...systemFacts(HEALTH)];

  for (const fact of facts) {
    assert.ok(fact.label.length > 0);
    assert.ok(fact.value.length > 0);
    assert.ok(fact.detail.length > 0, `${fact.label} has no explanation`);
    // No raw config identifier survives into the label or the value.
    assert.ok(!/_|[a-z][A-Z]/.test(fact.label), `${fact.label} is an identifier`);
    assert.ok(!/^(mock|local|demo|sqlite|true|false)$/i.test(fact.value), `${fact.label} shows a raw value`);
  }
});

test('sending being off is presented as a closed lock, not a fault', () => {
  const sending = systemFacts(HEALTH).find((fact) => fact.label === 'Sending replies');
  assert.ok(sending);

  assert.equal(sending.value, 'Off');
  // Nothing is wrong when sending is off — it is the safe default, so it must
  // not be coloured as a failure.
  assert.equal(sending.tone, 'good');
  assert.match(sending.detail, /nothing reaches a customer/i);
  // The single most misleading thing this line could imply.
  assert.ok(!/\bsent\b/i.test(sending.detail), 'the status implies delivery');
});

test('demo mode is stated plainly rather than hidden or dressed up', () => {
  const model = systemFacts(HEALTH).find((fact) => fact.label === 'Language model');
  assert.ok(model);

  // "mock" is jargon; pretending it is a live model would be a lie. Neither.
  assert.equal(model.value, 'Demo mode');
  assert.ok(!/mock/i.test(model.value + model.detail), 'the status says "mock"');
  assert.match(model.detail, /recorded responses/i);
});

test('a live model and a configured mailbox are reported as themselves', () => {
  const live: Health = {
    ...HEALTH,
    adapters: { ...HEALTH.adapters, llmProvider: 'anthropic', emailSource: 'gmail', crmTarget: 'hubspot' },
  };
  const facts = systemFacts(live);

  assert.equal(facts.find((f) => f.label === 'Language model')?.value, 'Claude');
  assert.equal(facts.find((f) => f.label === 'Email source')?.value, 'Gmail');
  assert.equal(facts.find((f) => f.label === 'CRM')?.value, 'HubSpot');
});

test('an unconfigured sign-in is reported as a problem', () => {
  const open: Health = { ...HEALTH, adapters: { ...HEALTH.adapters, authConfigured: false } };
  const signIn = systemFacts(open).find((fact) => fact.label === 'Sign-in');

  assert.ok(signIn);
  assert.equal(signIn.tone, 'bad');
  assert.match(signIn.detail, /not suitable for real data/i);
});

test('the autonomy level is not reported from configuration', () => {
  // Health reads it from config; the running system reads it from `settings`,
  // and the demo seed makes the two disagree. Reporting the config value would
  // be stating something the system contradicts.
  const facts = systemFacts(HEALTH);
  const text = facts.map((fact) => `${fact.label} ${fact.value} ${fact.detail}`).join(' ');

  assert.ok(!/autonomy/i.test(text), 'autonomy level is reported from the wrong source');
  assert.ok(!facts.some((fact) => fact.value === 'manual'), 'a raw autonomy value is shown');
});

test('a degraded system says so', () => {
  const broken: Health = { ...HEALTH, status: 'degraded', database: { ...HEALTH.database, reachable: false } };
  const status = connectionStatus(broken);

  assert.equal(status.value, 'Degraded');
  assert.equal(status.tone, 'bad');
});

// --- the security closer -----------------------------------------------------

test('the injection defence leads with the guarantee, not with a miss', () => {
  const notFlagged = describeDefence(false);

  // The old sentence opened "The agent itself did not flag this", which reads
  // as a failure before it reads as a design property.
  assert.match(notFlagged.headline, /caught/i);
  assert.ok(!/^the agent (itself )?did not/i.test(notFlagged.detail));

  // And it must not speak in engineering vocabulary.
  for (const jargon of [/deterministic/i, /detector/i, /regex/i, /heuristic/i, /rule engine/i]) {
    assert.ok(!jargon.test(notFlagged.headline + notFlagged.detail), `the defence says ${jargon}`);
  }
});

test('both branches state the same guarantee', () => {
  // The catch never depended on the model, whether or not the model agreed.
  for (const flagged of [true, false]) {
    const defence = describeDefence(flagged);
    assert.match(defence.detail, /does not depend on the AI noticing/i);
    assert.equal(defence.headline, 'Caught by a security check that runs on every email');
  }

  assert.notEqual(describeDefence(true).detail, describeDefence(false).detail);
});

test('the injection banner renders no internal rule identifiers', () => {
  const screen = stripComments(fs.readFileSync(path.join(SRC, 'screens/EmailDetail.tsx'), 'utf8'));

  // `match.rule` may still key the list — it may not be rendered.
  assert.ok(!/>\s*\{match\.rule\}/.test(screen), 'the raw rule name is rendered');
  assert.ok(!/\{match\.rule\}<\/span>/.test(screen), 'the raw rule name is rendered');
  assert.match(screen, /key=\{match\.rule\}/, 'the rule is no longer used as a key');
  // The rule's plain-language explanation is what a client reads instead.
  assert.match(screen, /\{match\.why\}/);
});

// --- email state presentation ------------------------------------------------

const ALL_STATES = [
  'received',
  'understanding',
  'understand_failed',
  'resolving',
  'deciding',
  'awaiting_approval',
  'needs_review',
  'executing',
  'completed',
  'rejected',
  'execution_failed',
  'expired',
  'archived',
];

test('every email state has a plain-language label', () => {
  for (const state of ALL_STATES) {
    const presentation = stateLabel(state);
    assert.ok(!presentation.label.includes('_'), `${state} was not translated`);
    assert.ok(presentation.marker.trim().length > 0, `${state} has no non-colour cue`);

    // A compound enum name must not survive as merely itself with the
    // underscores taken out — "understand failed" was the old chip's output and
    // is not a phrase anyone says. Single-word states are exempt: "Received" is
    // already the right English word for `received`, and inventing a synonym
    // to satisfy a test would make the screen worse.
    if (state.includes('_')) {
      assert.notEqual(
        presentation.label.toLowerCase(),
        state.replace(/_/g, ' '),
        `${state} is the enum with its underscores removed`,
      );
    }
  }
});

test('tone means the same thing everywhere', () => {
  // The bug this replaces: `resolving` — mid-pipeline — was green, while
  // `execution_failed`, `rejected` and `expired` were the same neutral grey as
  // an idle state, so a failure looked like nothing had happened.
  assert.equal(stateLabel('resolving').tone, 'working');
  assert.equal(stateLabel('completed').tone, 'done');

  for (const state of ['execution_failed', 'understand_failed', 'rejected']) {
    assert.equal(stateLabel(state).tone, 'failed', `${state} does not look like a failure`);
  }
  for (const state of ['needs_review', 'awaiting_approval', 'expired']) {
    assert.equal(stateLabel(state).tone, 'attention', `${state} does not ask for a person`);
  }
});

test('an unknown state degrades rather than throwing', () => {
  const unknown = stateLabel('some_new_state');
  assert.equal(unknown.label, 'some new state');
  assert.ok(unknown.marker.length > 0);
});

test('review reasons read as explanations, not enum values', () => {
  const reasons = [
    'low_confidence',
    'insufficient_information',
    'ambiguous_intent',
    'match_conflict',
    'possible_injection',
    'draft_blocked',
    'execution_failed',
    'no_valid_plan',
    'approval_expired',
  ];

  for (const reason of reasons) {
    const label = reviewReasonLabel(reason);
    assert.ok(!label.includes('_'), `${reason} was not translated`);
    assert.ok(label.split(' ').length >= 4, `"${label}" is still a label, not an explanation`);
  }

  assert.match(reviewReasonLabel('possible_injection'), /trying to give the assistant instructions/i);
  assert.match(reviewReasonLabel('approval_expired'), /not carried out/i);
});

test('no state label claims more than happened', () => {
  const labels = ALL_STATES.map((state) => stateLabel(state).label.toLowerCase());

  // Nothing may claim a reply reached anyone.
  for (const label of labels) {
    assert.ok(!/\bsent\b/.test(label), `"${label}" implies a reply was delivered`);
  }
  assert.ok(!/\bdone\b/.test(stateLabel('deciding').label.toLowerCase()));
  assert.ok(!/\bdone\b/.test(stateLabel('awaiting_approval').label.toLowerCase()));
});

// --- the stale-language scan (fix 7) ----------------------------------------
//
// The finding that made this necessary: `Overview.tsx` rendered "Arrives in M5"
// months after M5 shipped. A scan existed — and covered exactly one file.

/** The one component allowed to say a screen is unbuilt. */
const PLACEHOLDER_COMPONENT = 'components/MilestonePlaceholder.tsx';

const MILESTONE = /\bM\d+(?:-[A-Z](?:\.\d+)*)?\b/;
const STALE_PHRASES = [/arrives in/i, /coming soon/i, /\bTBD\b/, /\bWIP\b/, /lorem ipsum/i, /placeholder text/i];

test('no rendered text names a milestone', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    if (MILESTONE.test(source)) offenders.push(`${rel(file)} — ${MILESTONE.exec(source)?.[0]}`);
  }

  assert.deepEqual(offenders, [], `milestone labels reached the product:\n${offenders.join('\n')}`);
});

test('no screen carries stale or placeholder language', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const phrase of STALE_PHRASES) {
      if (phrase.test(source)) offenders.push(`${rel(file)} — ${phrase}`);
    }
  }

  assert.deepEqual(offenders, [], `stale language reached the product:\n${offenders.join('\n')}`);
});

test('only one component says a screen is unbuilt', () => {
  const offenders = sourceFiles()
    .filter((file) => rel(file) !== PLACEHOLDER_COMPONENT)
    .filter((file) => /not built yet/i.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map(rel);

  // Otherwise the wording drifts, and the copy that drifts is the one nobody
  // rereads until a client is looking at it.
  assert.deepEqual(offenders, [], `"not built yet" is written in more than one place: ${offenders.join(', ')}`);
});

test('the scan is not vacuous', () => {
  // A negative control. Every assertion above passes when the codebase is
  // clean, which is also what a broken scan looks like — so prove the patterns
  // actually fire on the exact text that shipped.
  const shipped = '<p className="text-eyebrow uppercase text-signal">Arrives in M5</p>';

  assert.ok(MILESTONE.test(shipped), 'the milestone pattern would not have caught "Arrives in M5"');
  assert.ok(STALE_PHRASES.some((phrase) => phrase.test(shipped)), 'the phrase list would not have caught it');

  // And prove comments are stripped, or every file mentioning a milestone in a
  // comment would fail and the scan would be turned off.
  assert.ok(!MILESTONE.test(stripComments('// built in M6-E\nconst a = 1;')));
  assert.ok(!MILESTONE.test(stripComments('/* M4-B shipped this */\nconst b = 2;')));
  // Stripping must not swallow real code.
  assert.match(stripComments('// note\nconst real = "M5";'), /const real/);
  assert.ok(MILESTONE.test(stripComments('// note\nconst real = "M5";')), 'a milestone in a string escaped');
});

test('the scan actually reads the screens it claims to', () => {
  const files = sourceFiles().map(rel);

  // A scan that walked an empty directory would pass every assertion above.
  assert.ok(files.length > 15, `the scan found only ${files.length} files`);
  for (const required of ['screens/Overview.tsx', 'screens/EmailDetail.tsx', 'screens/Inbox.tsx', 'screens/Crm.tsx']) {
    assert.ok(files.includes(required), `the scan missed ${required}`);
  }
});
