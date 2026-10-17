import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateCase, type EvalCase } from '../src/eval/understand/metrics.ts';
import { loadDataset } from '../src/eval/understand/runner.ts';
import type { UnderstandOutcome } from '../src/agent/understand/understand.ts';
import { DEMO_DATA_DIR } from './helpers.ts';

// E-04 may end UNDERSTAND with a person through the follow_up_without_context rule instead of reaching RESOLVE. The gold
// accepts that, but only when the named rule actually fired and the outcome is exactly the one listed.

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const e04 = loadDataset(path.join(SERVER_ROOT, 'eval', 'understand.dataset.json')).cases.find((c) => c.id === 'E-04') as EvalCase;

function outcome(overrides: { category: string; state: string; reviewReason: string | null; rule?: string }): UnderstandOutcome {
  const field = (value: string | null) => ({ value, confidence: 0.9, sourceSpan: value });
  return {
    email: { fromName: 'Mark Doyle', fromEmail: 'mark@harborview-group.invalid', toEmail: 'x@y.invalid', cc: null, subject: 'Reporting work', bodyText: 'Mark Doyle, Harborview Group', receivedAt: '2026-08-24T09:12:00.000Z', threadId: null },
    state: overrides.state,
    reviewReason: overrides.reviewReason,
    understanding: {
      category: overrides.category,
      priority: 'medium',
      confidenceBand: 'high',
      confidence: 0.9,
      flags: {},
      extracted: { contactName: field('Mark Doyle'), companyDomain: field('harborview-group.invalid'), companyName: field('Harborview Group'), requirementSummary: field('reporting') },
      questionAsked: 'Could we set up a call?',
    },
    security: { injection: { suspected: false, matches: [] } },
    validation: {
      droppedFields: [],
      coherenceAdjustments: overrides.rule ? [{ what: 'changed the category', why: 'x', rule: overrides.rule }] : [],
    },
  } as unknown as UnderstandOutcome;
}

const passed = (o: UnderstandOutcome, name: string) => evaluateCase(e04, o).checks.find((c) => c.name === name)!;

test('the original route still passes: read as a service inquiry, resolving', () => {
  const o = outcome({ category: 'service_inquiry', state: 'resolving', reviewReason: null });
  for (const name of ['category', 'state', 'review_reason']) assert.equal(passed(o, name).passed, true, name);
});

test('the new route passes when the rule fired: ambiguous, needs_review, ambiguous_intent', () => {
  const o = outcome({ category: 'ambiguous', state: 'needs_review', reviewReason: 'ambiguous_intent', rule: 'follow_up_without_context' });
  for (const name of ['category', 'state', 'review_reason']) {
    assert.equal(passed(o, name).passed, true, name);
    assert.match(passed(o, name).detail, /accepted alternative: needs_review via follow_up_without_context, which also ends with a person/);
  }
});

test('the same end state without the rule is NOT accepted, and neither is any other outcome', () => {
  const noRule = outcome({ category: 'ambiguous', state: 'needs_review', reviewReason: 'ambiguous_intent' });
  assert.equal(passed(noRule, 'category').passed, false);
  assert.equal(passed(noRule, 'state').passed, false);
  const wrongReason = outcome({ category: 'ambiguous', state: 'needs_review', reviewReason: 'low_confidence', rule: 'follow_up_without_context' });
  assert.equal(passed(wrongReason, 'review_reason').passed, false);
  const wrongCategory = outcome({ category: 'sales_inquiry', state: 'needs_review', reviewReason: 'ambiguous_intent', rule: 'follow_up_without_context' });
  assert.equal(passed(wrongCategory, 'category').passed, false);
  const otherRule = outcome({ category: 'ambiguous', state: 'needs_review', reviewReason: 'ambiguous_intent', rule: 'some_other_rule' });
  assert.equal(passed(otherRule, 'state').passed, false);
});

test('E-04 changed in the dataset and in its history, and nothing else gained an alternative outcome', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'eval', 'understand.dataset.json'), 'utf8')) as {
    cases: Array<{ id: string; goldHistory?: Array<{ why: string; version: string }>; expected: { alsoAcceptOutcomes?: unknown[] } }>;
  };
  assert.deepEqual(raw.cases.filter((c) => c.expected.alsoAcceptOutcomes).map((c) => c.id), ['E-04']);
  const history = raw.cases.find((c) => c.id === 'E-04')!.goldHistory![0]!;
  assert.equal(history.why, 'changed after the follow_up_without_context rule (built for E-08) altered its route; outcome unchanged');
  assert.equal(history.version, 'understand-1.2.0');
});
