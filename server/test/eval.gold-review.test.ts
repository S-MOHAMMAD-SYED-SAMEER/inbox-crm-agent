import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateCase, type EvalCase } from '../src/eval/understand/metrics.ts';
import type { UnderstandOutcome } from '../src/agent/understand/understand.ts';
import { loadDataset } from '../src/eval/understand/runner.ts';
import { loadDecideDataset } from '../src/eval/decide/runner.ts';
import { DEMO_DATA_DIR } from './helpers.ts';

// What the gold review changed, pinned: the versions, the per-item history, and the one new kind of expectation (a case that
// accepts two categories).

const SERVER_ROOT = path.resolve(DEMO_DATA_DIR, '..', '..');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'eval', name), 'utf8'));

test('each reviewed dataset is version 1.1.0 and says what changed, per item', () => {
  const understand = read('understand.dataset.json');
  assert.equal(understand.version, 'understand-1.1.0');
  assert.equal(read('resolve.dataset.json').version, 'resolve-1.1.0');
  assert.equal(read('decide.dataset.json').version, 'decide-1.1.0');

  const changed = (dataset: { cases: Array<{ id: string; goldHistory?: Array<{ version: string; reviewedBy: string; date: string; from: unknown; to: unknown; why: string }> }> }) =>
    dataset.cases.filter((c) => c.goldHistory).map((c) => c.id);
  assert.deepEqual(changed(understand), ['E-02', 'E-05', 'E-09']);
  assert.deepEqual(changed(read('decide.dataset.json')), ['E-01', 'E-02', 'E-03', 'E-06', 'E-07']);
  for (const dataset of [understand, read('decide.dataset.json')]) {
    for (const c of dataset.cases) {
      for (const entry of c.goldHistory ?? []) {
        assert.match(entry.version, /-1\.1\.0$/);
        assert.match(entry.reviewedBy, /approved by Sameer/);
        assert.equal(entry.date, '2026-10-17');
        assert.ok(entry.why.length > 20 && entry.from !== undefined && entry.to !== undefined, `${c.id} has an incomplete history entry`);
      }
    }
  }
});

test('the reviewed expectations are the ones the review approved', () => {
  const u = loadDataset(path.join(SERVER_ROOT, 'eval', 'understand.dataset.json'));
  const byId = (id: string) => u.cases.find((c) => c.id === id)!.expected;
  assert.equal(byId('E-02').mustExtract.timeline, 'this year');
  assert.deepEqual(byId('E-02').mustBeNotProvided, ['budget']);
  assert.ok(byId('E-02').droppedFields.includes('budget'));
  assert.equal(byId('E-05').priority, 'high');
  assert.deepEqual([byId('E-09').category, ...(byId('E-09').alsoAcceptCategories ?? [])].sort(), ['spam', 'vendor_pitch']);

  const d = loadDecideDataset(path.join(SERVER_ROOT, 'eval', 'decide.dataset.json'));
  const e06 = d.cases.find((c) => c.id === 'E-06')!.expected;
  assert.deepEqual(e06.actions, ['log_activity', 'update_deal_stage', 'create_task']);
  assert.equal(e06.hasDraft, false);
  for (const id of ['E-01', 'E-02', 'E-03', 'E-06']) {
    assert.deepEqual(d.cases.find((c) => c.id === id)!.expected.approvalReasonCodes, ['consequential_action', 'autonomy_level'], id);
  }
  assert.deepEqual(d.cases.find((c) => c.id === 'E-07')!.expected.approvalReasonCodes, ['autonomy_level']);
});

test('a case that accepts two categories passes for either and fails for any other', () => {
  const c = loadDataset(path.join(SERVER_ROOT, 'eval', 'understand.dataset.json')).cases.find((x) => x.id === 'E-09') as EvalCase;
  const outcome = (category: string) =>
    ({
      state: 'resolving',
      reviewReason: null,
      understanding: {
        category,
        priority: 'low',
        confidenceBand: 'high',
        flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: false },
        extracted: {},
        questionAsked: null,
      },
      security: { injection: { suspected: false, matches: [] } },
      validation: { droppedFields: [] },
    }) as unknown as UnderstandOutcome;
  const categoryCheck = (category: string) => evaluateCase(c, outcome(category)).checks.find((check) => check.name === 'category')!;
  assert.equal(categoryCheck('spam').passed, true);
  assert.equal(categoryCheck('vendor_pitch').passed, true);
  assert.equal(categoryCheck('sales_inquiry').passed, false);
  assert.match(categoryCheck('sales_inquiry').detail, /expected spam or vendor_pitch, got sales_inquiry/);
});
