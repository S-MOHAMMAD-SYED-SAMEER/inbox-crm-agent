import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actorLabel,
  eventLabel,
  formatAmount,
  formatDate,
  isOverdue,
  outcomeLabel,
  presentSource,
  stageLabel,
  taskStatusLabel,
} from '../src/crm/presentation.ts';
import { isPlaceholderRoute } from '../src/screens/placeholderRoutes.ts';
import { ROUTES } from '../src/router.ts';

// M6-C — the CRM screens.
//
// The presentation rules are tested; the tables are thin renderers over them,
// which is the same split the revision and outbox screens use (NFR-9, no jsdom).
//
// The rule that matters most here is the source badge. It is the moment a client
// sees which rows the assistant produced — so it must be visible, must not
// depend on colour, and must not overstate what "from the assistant" means.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');
const code = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// --- the source badge --------------------------------------------------------

test('every record source is presented distinctly and without colour alone', () => {
  const sources = ['agent', 'human', 'seed'] as const;
  const markers = sources.map((source) => presentSource(source).marker);

  assert.equal(new Set(markers).size, 3, 'two sources share a marker');
  for (const source of sources) {
    const presentation = presentSource(source);
    assert.ok(presentation.label.length > 0);
    assert.ok(presentation.description.length > 0);
  }
});

test('the agent badge says what it means without overstating it', () => {
  const agent = presentSource('agent');

  assert.equal(agent.label, 'From the assistant');
  // It got there because a person approved a plan, and nothing changes it
  // afterwards without another approval. The description must say so.
  assert.match(agent.description, /approved/i);

  // Nothing implying the record manages or changes itself.
  for (const forbidden of [/autonomous/i, /AI-managed/i, /self-/i, /automatic(ally)? updat/i]) {
    assert.ok(!forbidden.test(agent.label + agent.description), `the badge claims ${forbidden}`);
  }
});

test('an unknown source degrades rather than throwing', () => {
  const unknown = presentSource('something-else' as never);
  assert.ok(unknown.label.length > 0);
});

// --- money -------------------------------------------------------------------

test('an unset deal value reads as unset, never as zero', () => {
  // The assistant deliberately does not invent a number from an email. A zero
  // would look like one it had.
  assert.equal(formatAmount(null, 'USD'), 'Not set');
  assert.notEqual(formatAmount(null, 'USD'), '$0');
});

test('money is formatted from minor units', () => {
  assert.match(formatAmount(250000, 'USD'), /2,500/);
  assert.match(formatAmount(0, 'USD'), /0/);
});

test('an unknown currency does not blank the column', () => {
  const formatted = formatAmount(150000, 'XYZ');
  assert.ok(formatted.length > 0);
  assert.match(formatted, /1500|XYZ/);
});

// --- dates and overdue -------------------------------------------------------

test('dates are readable, and a missing date is a dash', () => {
  const formatted = formatDate('2026-08-27T09:00:00.000Z');
  assert.ok(!formatted.includes('2026-08-27T'), 'a raw ISO string reached the screen');
  assert.ok(formatted.length > 0);

  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('not-a-date'), '—');
});

test('only an open task with a past due date is overdue', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');

  assert.equal(isOverdue('2026-08-01T00:00:00.000Z', 'open', now), true);
  assert.equal(isOverdue('2026-10-01T00:00:00.000Z', 'open', now), false);
  // A completed task cannot be overdue, however old it is.
  assert.equal(isOverdue('2026-08-01T00:00:00.000Z', 'done', now), false);
  assert.equal(isOverdue(null, 'open', now), false);
  assert.equal(isOverdue('nonsense', 'open', now), false);
});

// --- labels ------------------------------------------------------------------

test('database values are shown in plain language', () => {
  assert.equal(stageLabel('new_lead'), 'New lead');
  assert.equal(taskStatusLabel('open'), 'Open');

  // Unknown values degrade to something readable rather than raw snake_case.
  assert.equal(stageLabel('some_new_stage'), 'some new stage');
  assert.ok(!stageLabel('some_new_stage').includes('_'));
});

test('audit event types read as sentences, not identifiers', () => {
  const cases: Array<[string, RegExp]> = [
    ['plan_revised', /edited by a person/i],
    ['approval_granted', /approved/i],
    ['injection_suspected', /suspicious/i],
    ['outbox_suppressed', /held|sending is off/i],
    ['outbound_send_succeeded', /delivered/i],
  ];

  for (const [eventType, pattern] of cases) {
    assert.match(eventLabel(eventType), pattern, `${eventType} reads badly`);
  }

  // No label leaks a raw identifier.
  for (const [eventType] of cases) {
    assert.ok(!eventLabel(eventType).includes('_'), `${eventType} was not translated`);
  }

  assert.equal(eventLabel('a_brand_new_event'), 'a brand new event');
});

test('a suppressed reply is never described as sent', () => {
  // The single most misleading thing this screen could say.
  const suppressed = eventLabel('outbox_suppressed');
  assert.ok(!/\bsent\b/i.test(suppressed), `"${suppressed}" implies delivery`);
  assert.match(suppressed, /sending is off/i);
});

test('actors and outcomes are labelled with a non-colour cue', () => {
  for (const actor of ['system', 'ai', 'human']) {
    const presentation = actorLabel(actor);
    assert.ok(presentation.label.length > 0);
    assert.ok(presentation.marker.trim().length > 0);
  }

  assert.equal(outcomeLabel('ok').label, 'Done');
  assert.equal(outcomeLabel('blocked').tone, 'stopped');
  assert.equal(outcomeLabel('failed').tone, 'failed');
  assert.equal(outcomeLabel('unknown-outcome').label, 'unknown-outcome');
});

// --- routing -----------------------------------------------------------------

test('the built CRM screens are no longer placeholders', () => {
  for (const route of ['deals', 'contacts', 'companies', 'tasks', 'audit'] as const) {
    assert.equal(isPlaceholderRoute(route), false, `${route} still renders a placeholder`);
  }

  // Only these two remain unbuilt.
  const remaining = ROUTES.filter((route) => isPlaceholderRoute(route));
  assert.deepEqual([...remaining].sort(), ['automation', 'settings']);
});

test('no built screen carries "coming soon" language', () => {
  const screens = code('screens/Crm.tsx');
  for (const forbidden of [/coming soon/i, /arrives in/i, /not built/i, /milestone/i]) {
    assert.ok(!forbidden.test(screens), `the CRM screens contain ${forbidden}`);
  }
});

// --- the screens render server truth -----------------------------------------

test('the CRM screens invent no data of their own', () => {
  const screens = code('screens/Crm.tsx');

  // No fixture arrays, no placeholder rows, no random values.
  assert.ok(!/Math\.random|faker|lorem|placeholderRows|SAMPLE_/i.test(screens), 'a screen fabricates data');
  // Every list comes from the client.
  for (const method of ['listDeals', 'listContacts', 'listCompanies', 'listTasks', 'listAudit']) {
    assert.ok(screens.includes(`api.${method}`), `${method} is not used`);
  }
});

test('the CRM screens are read-only', () => {
  const screens = code('screens/Crm.tsx');
  // No mutating client call reaches these screens.
  for (const method of ['approve(', 'reject(', 'revise(', 'execute(', 'ingest(']) {
    assert.ok(!screens.includes(`api.${method}`), `a CRM screen calls api.${method}`);
  }
});

// --- table shell --------------------------------------------------------------

test('the shared table has real loading, empty and error states', () => {
  const table = code('components/recordTable.tsx');

  assert.match(table, /Loading \{noun\}/, 'there is no loading state');
  assert.match(table, /No \{noun\} yet/, 'there is no empty state');
  assert.match(table, /Could not load/, 'there is no error state');
  assert.match(table, /Try again/, 'an error offers no recovery');

  // The error shows the server's sentence, never internals.
  assert.ok(!/err\.stack|JSON\.stringify\(err|err\.code/.test(table), 'the error state exposes internals');
});

test('wide tables scroll inside their own container, not the page', () => {
  const table = read('components/recordTable.tsx');
  const container = table.indexOf('overflow-x-auto');
  const wide = table.indexOf('min-w-[');

  assert.ok(container >= 0, 'the table has no scroll container');
  assert.ok(wide > container, 'the wide table sits outside the scroll container');
  assert.ok(!/\bw-screen\b/.test(table));
});

test('table controls are keyboard operable and announce their state', () => {
  const table = code('components/recordTable.tsx');

  assert.match(table, /type="button"/);
  assert.match(table, /aria-pressed=/, 'filter chips do not announce selection');
  assert.match(table, /aria-live="polite"/, 'state changes are not announced');
  assert.match(table, /focus-visible:outline/, 'controls have no visible focus state');
  assert.match(table, /scope="col"/, 'table headers are not associated with their columns');
});
