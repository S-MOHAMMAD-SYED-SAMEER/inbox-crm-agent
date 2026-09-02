import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_STATES,
  buildRevisionHistory,
  canEdit,
  isActionable,
  presentApproval,
  revisionSuccessMessage,
} from '../src/revision/approvalPresentation.ts';
import {
  ACTION_LABELS,
  actionLabel,
  currentValue,
  editableFieldsFor,
  isEditableAction,
  NOT_EDITABLE_REASON,
  PRIORITIES,
} from '../src/revision/editableFields.ts';
import {
  actionPath,
  buildEditEnvelope,
  canSubmit,
  draftPath,
  initialEditDraft,
  summariseChanges,
} from '../src/revision/editState.ts';
import { describeReviseError, problemPath } from '../src/revision/reviseErrors.ts';
import { presentOutbox } from '../src/revision/outboxPresentation.ts';
import { describeExecution } from '../src/revision/executionSummary.ts';
import { ApiError } from '../src/api/client.ts';
import type { ActionPlan, DecisionRevision } from '../src/api/types.ts';

// M4-C.3 — the human revision experience.
//
// Tested the way this project tests frontend logic: plain modules under Node's
// own runner, no jsdom and no Testing Library (NFR-9). That constraint shaped
// the code as much as the tests — everything that decides *what the screen may
// do* lives in `src/revision/`, and the components are thin renderers over it.
// A rule that only exists inside JSX is a rule nobody can check.
//
// The property running underneath most of this: **editing is not approving**.
// A revision leaves the plan waiting for a person, and no label, state or
// control on this screen may suggest otherwise.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

function plan(overrides: Partial<ActionPlan> = {}): ActionPlan {
  return {
    actions: [
      { type: 'create_company', payload: { name: 'Acme Commerce', domain: 'acmecommerce.invalid' } },
      {
        type: 'create_task',
        payload: {
          title: 'Follow up with Sarah',
          description: null,
          dueAt: '2026-09-01T09:00:00.000Z',
          priority: 'high',
          contact: { kind: 'new', ref: 'contact' },
        },
      },
      { type: 'add_note', payload: { body: 'Asked about cart recovery.' } },
      { type: 'log_activity', payload: { subject: 'Inbound enquiry', body: 'Sarah got in touch.' } },
      { type: 'send_email', payload: { toEmail: 'sarah@acmecommerce.invalid' } },
    ],
    riskTier: 2,
    requiresApproval: true,
    approvalReasons: [{ code: 'consequential_action', message: 'This plan sends a reply.' }],
    rationale: 'A new lead worth following up.',
    ruleTrace: [],
    draft: { subject: 'Re: your enquiry', body: 'Hi Sarah,\n\nThanks for getting in touch.', guardrailsPassed: [], blockedBy: [] },
    draftFailedReason: null,
    ...overrides,
  };
}

const TASK = 1;
const NOTE = 2;
const ACTIVITY = 3;
const SEND = 4;

function revision(over: Partial<DecisionRevision> = {}): DecisionRevision {
  return {
    id: 'd1',
    revision: 1,
    origin: 'agent',
    editedBy: null,
    parentDecisionId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    approvalState: 'pending',
    isCurrent: true,
    ...over,
  };
}

// --- 1, 21, 22  approval states --------------------------------------------

test('all five approval states are presented, superseded included', () => {
  assert.deepEqual([...APPROVAL_STATES], ['pending', 'approved', 'rejected', 'expired', 'superseded']);

  const superseded = presentApproval('superseded');
  assert.equal(superseded.label, 'Replaced');
  assert.equal(superseded.description, 'This revision was replaced by a newer decision.');
  assert.equal(superseded.actionable, false);
});

test('a pending approval is actionable and every settled one is not', () => {
  assert.equal(isActionable({ state: 'pending' }), true);
  for (const state of ['approved', 'rejected', 'expired', 'superseded'] as const) {
    assert.equal(isActionable({ state }), false, `${state} was offered as actionable`);
  }
});

test('an overdue pending approval is not actionable even before the sweep runs', () => {
  assert.equal(isActionable({ state: 'pending' }, true), false);
});

test('every state carries a non-colour marker, so none of them depends on colour alone', () => {
  const markers = APPROVAL_STATES.map((state) => presentApproval(state).marker);
  assert.equal(new Set(markers).size, markers.length, 'two states share a marker');
  for (const state of APPROVAL_STATES) {
    const presentation = presentApproval(state);
    assert.ok(presentation.label.length > 0);
    assert.ok(presentation.marker.trim().length > 0);
  }
});

// --- 4, 5  revision history -------------------------------------------------

test('revision history shows the number, the author and the state of each revision', () => {
  const rows = buildRevisionHistory([
    revision({ id: 'd1', revision: 1, approvalState: 'superseded', isCurrent: false }),
    revision({
      id: 'd2',
      revision: 2,
      origin: 'human_edit',
      editedBy: 'Sameer',
      parentDecisionId: 'd1',
      approvalState: 'pending',
      isCurrent: true,
    }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.revision, row.authorLabel, row.stateLabel, row.isCurrent]),
    [
      [1, 'AI-generated', 'Replaced', false],
      [2, 'Human edit by Sameer', 'Waiting for you', true],
    ],
  );
});

test('a revision with no parent reads as the original decision', () => {
  const [first, second] = buildRevisionHistory([
    revision({ id: 'd1', revision: 1, isCurrent: false }),
    revision({ id: 'd2', revision: 2, origin: 'human_edit', editedBy: 'Sameer', parentDecisionId: 'd1' }),
  ]);

  assert.equal(first?.lineageLabel, 'Original decision');
  assert.equal(second?.lineageLabel, 'Revised from revision 1');
  assert.equal(first?.isHumanEdit, false);
  assert.equal(second?.isHumanEdit, true);
});

test('a human edit with no recorded editor still reads as a human edit', () => {
  const [row] = buildRevisionHistory([revision({ origin: 'human_edit', editedBy: null })]);
  assert.equal(row?.authorLabel, 'Human edit by someone');
});

test('a revision that never needed an approval says so rather than inventing a state', () => {
  const [row] = buildRevisionHistory([revision({ approvalState: null })]);
  assert.equal(row?.stateLabel, 'No approval needed');
  assert.equal(row?.tone, 'none');
});

// --- editability ------------------------------------------------------------

test('a plan is editable only while its approval is pending and nothing has run', () => {
  const base = {
    approval: { state: 'pending' as const },
    decision: { supersededBy: null },
    executions: [] as unknown[],
    email: { state: 'awaiting_approval' },
  };

  assert.equal(canEdit(base).editable, true);
  assert.equal(canEdit({ ...base, approval: { state: 'approved' } }).editable, false);
  assert.equal(canEdit({ ...base, approval: { state: 'rejected' } }).editable, false);
  assert.equal(canEdit({ ...base, approval: { state: 'expired' } }).editable, false);
  assert.equal(canEdit({ ...base, approval: { state: 'superseded' } }).editable, false);
  assert.equal(canEdit({ ...base, decision: { supersededBy: 'd2' } }).editable, false);
  assert.equal(canEdit({ ...base, email: { state: 'executing' } }).editable, false);
  assert.equal(canEdit({ ...base, executions: [{}] }).editable, false);
  assert.equal(canEdit({ ...base, decision: null }).editable, false);
  assert.equal(canEdit({ ...base, approval: null }).editable, false);
});

test('every refusal to edit explains itself', () => {
  const refusal = canEdit({
    approval: { state: 'pending' },
    decision: { supersededBy: null },
    executions: [{}],
    email: { state: 'awaiting_approval' },
  });
  assert.equal(refusal.editable, false);
  assert.match(refusal.reason ?? '', /already started making changes/);
});

// --- 6, 7, 8, 9, 10  the editable surface -----------------------------------

test('the draft exposes exactly subject and body', () => {
  const fields = initialEditDraft(plan());
  assert.ok(Object.hasOwn(fields, draftPath('subject')));
  assert.ok(Object.hasOwn(fields, draftPath('body')));
  assert.equal(Object.keys(fields).filter((key) => key.startsWith('draft.')).length, 2);
});

test('create_task exposes title, description, due date and priority — and nothing else', () => {
  assert.deepEqual(
    editableFieldsFor('create_task').map((field) => field.field),
    ['title', 'description', 'dueAt', 'priority'],
  );

  const priority = editableFieldsFor('create_task').find((field) => field.field === 'priority');
  assert.equal(priority?.control, 'select');
  assert.deepEqual([...(priority?.options ?? [])], [...PRIORITIES]);

  const due = editableFieldsFor('create_task').find((field) => field.field === 'dueAt');
  assert.equal(due?.control, 'datetime');
});

test('add_note exposes only its body', () => {
  assert.deepEqual(editableFieldsFor('add_note').map((field) => field.field), ['body']);
});

test('log_activity exposes only subject and body', () => {
  assert.deepEqual(editableFieldsFor('log_activity').map((field) => field.field), ['subject', 'body']);
});

test('no other action is editable, and each still has a readable name', () => {
  const editable = ['create_task', 'add_note', 'log_activity'];

  for (const type of Object.keys(ACTION_LABELS)) {
    assert.equal(
      isEditableAction(type),
      editable.includes(type),
      `${type} disagreed with the whitelist`,
    );
    assert.ok(actionLabel(type).length > 0);
  }

  // The ones that decide who is contacted, what a deal is worth, or where it
  // sits — none of them may be edited from an approval screen.
  for (const type of [
    'create_company',
    'create_contact',
    'link_contact_to_company',
    'create_deal',
    'update_deal_stage',
    'update_deal_amount',
    'send_email',
    'archive_email',
  ]) {
    assert.deepEqual(editableFieldsFor(type), []);
  }
});

test('an immutable action offers an explanation instead of a control', () => {
  assert.equal(isEditableAction('update_deal_amount'), false);
  assert.match(NOT_EDITABLE_REASON, /new agent decision/);
  // And no hint about a way round it.
  assert.ok(!/api|endpoint|database|sql|admin/i.test(NOT_EDITABLE_REASON));
});

test('the edit form is seeded from the plan, never from blank values', () => {
  const draft = initialEditDraft(plan());
  assert.equal(draft[draftPath('subject')], 'Re: your enquiry');
  assert.equal(draft[actionPath(TASK, 'title')], 'Follow up with Sarah');
  assert.equal(draft[actionPath(TASK, 'priority')], 'high');
  assert.equal(draft[actionPath(NOTE, 'body')], 'Asked about cart recovery.');
  assert.equal(draft[actionPath(ACTIVITY, 'subject')], 'Inbound enquiry');

  // No key at all for an action with nothing editable.
  assert.equal(Object.keys(draft).some((key) => key.startsWith(`actions.${SEND}.`)), false);
});

test('a null payload value becomes an empty control rather than the string "null"', () => {
  assert.equal(currentValue({ type: 'create_task', payload: { description: null } }, 'description'), '');
  assert.equal(currentValue({ type: 'create_task', payload: {} }, 'description'), '');
});

// --- 11, 12  the change summary ---------------------------------------------

test('only changed fields appear in the summary', () => {
  const p = plan();
  const edited = { ...initialEditDraft(p), [actionPath(TASK, 'priority')]: 'medium' };

  const changes = summariseChanges(p, edited, actionLabel);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    path: actionPath(TASK, 'priority'),
    label: 'Schedule a follow-up · Priority',
    before: 'high',
    after: 'medium',
  });
});

test('unchanged fields never appear, even when they were touched and restored', () => {
  const p = plan();
  const draft = initialEditDraft(p);

  const edited = { ...draft, [draftPath('body')]: 'something else' };
  assert.equal(summariseChanges(p, edited, actionLabel).length, 1);

  const restored = { ...edited, [draftPath('body')]: draft[draftPath('body')] as string };
  assert.deepEqual(summariseChanges(p, restored, actionLabel), []);
});

test('a multi-field edit summarises every change with a readable label', () => {
  const p = plan();
  const edited = {
    ...initialEditDraft(p),
    [draftPath('subject')]: 'A calmer subject',
    [actionPath(NOTE, 'body')]: 'Wants cart recovery before November.',
  };

  assert.deepEqual(
    summariseChanges(p, edited, actionLabel).map((change) => change.label),
    ['Reply · Subject', 'Add an internal note · Note'],
  );
});

// --- 13, 14  submission -----------------------------------------------------

test('the envelope carries only changed paths, in the shape the API defines', () => {
  const p = plan();
  const edited = {
    ...initialEditDraft(p),
    [draftPath('subject')]: 'A calmer subject',
    [actionPath(TASK, 'priority')]: 'low',
  };

  assert.deepEqual(buildEditEnvelope(p, edited), {
    draft: { subject: 'A calmer subject' },
    actions: [{ index: TASK, field: 'priority', value: 'low', type: 'create_task' }],
  });
});

test('a nullable field cleared by the reviewer is sent as null, not an empty string', () => {
  const p = plan();
  p.actions[TASK]!.payload = { ...(p.actions[TASK]!.payload as object), description: 'Some detail' };

  const edited = { ...initialEditDraft(p), [actionPath(TASK, 'description')]: '   ' };
  const envelope = buildEditEnvelope(p, edited);

  assert.equal(envelope.actions?.[0]?.value, null);
});

test('the envelope never names an immutable field', () => {
  const p = plan();
  // Even if state somehow held a value for a field outside the whitelist, it
  // cannot reach the request: the envelope is built from the whitelist, not
  // from the keys in state.
  const edited = { ...initialEditDraft(p), [actionPath(SEND, 'toEmail')]: 'attacker@evil.example' };

  const envelope = buildEditEnvelope(p, edited);
  assert.equal(envelope.actions, undefined);
  assert.equal(JSON.stringify(envelope).includes('attacker'), false);
});

test('submission is blocked while in flight and when nothing changed', () => {
  assert.equal(canSubmit({ submitting: false, changeCount: 1 }), true);
  assert.equal(canSubmit({ submitting: true, changeCount: 1 }), false, 'a double submit was allowed');
  assert.equal(canSubmit({ submitting: false, changeCount: 0 }), false);
  assert.equal(canSubmit({ submitting: true, changeCount: 0 }), false);
});

test('the client posts a revision to the decision revise endpoint', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ revision: 2 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    const { api } = await import('../src/api/client.ts');
    await api.revise('decision-1', { draft: { subject: 'New subject' } });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? '', /\/decisions\/decision-1\/revise$/);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { edits: { draft: { subject: 'New subject' } } });
});

// --- 15, 16, 17  what a successful revision shows ---------------------------

test('after a revision the history shows the old approval replaced and the new one waiting', () => {
  // The shape the server actually returns (M4-C.2 + the revisions list).
  const rows = buildRevisionHistory([
    revision({ id: 'd1', revision: 1, approvalState: 'superseded', isCurrent: false }),
    revision({
      id: 'd2',
      revision: 2,
      origin: 'human_edit',
      editedBy: 'Sameer',
      parentDecisionId: 'd1',
      approvalState: 'pending',
      isCurrent: true,
    }),
  ]);

  const current = rows.find((row) => row.isCurrent);
  assert.equal(current?.revision, 2);
  assert.equal(current?.stateLabel, 'Waiting for you');
  assert.equal(rows.find((row) => !row.isCurrent)?.stateLabel, 'Replaced');

  // And the new revision is still editable and still needs approving.
  assert.equal(isActionable({ state: 'pending' }), true);
  assert.equal(isActionable({ state: 'superseded' }), false);
});

test('nothing in the success wording claims the revision was approved, executed or sent', () => {
  const message = revisionSuccessMessage(2);

  assert.match(message, /^Revision 2 created and submitted for approval\./);
  assert.match(message, /nothing has been carried out yet/);

  // Creating a revision is not approving it. The message must never promise an
  // outcome the API did not report.
  for (const forbidden of [/approved/i, /executed/i, /sent/i, /done/i]) {
    assert.ok(!forbidden.test(message), `the success message claims ${forbidden}`);
  }
});

// --- 18, 19, 20  errors -----------------------------------------------------

test('a validation error lists the problems and points at the field', () => {
  const view = describeReviseError(
    new ApiError(400, 'VALIDATION_ERROR', 'This edit could not be applied.', {
      problems: ['"edits.draft.subject" must not be empty'],
    }),
  );

  assert.equal(view.kind, 'validation');
  assert.equal(view.problems.length, 1);
  assert.equal(view.guardrails.length, 0);
  assert.equal(problemPath(view.problems[0] as string), 'draft.subject');
});

test('a problem naming an action edit points at that action', () => {
  assert.equal(problemPath('"edits.actions[2].value" must be in the future'), 'actions.2');
  assert.equal(problemPath('this problem names no path'), null);
});

test('a guardrail refusal is shown as a safety block, naming the checks and no customer text', () => {
  const view = describeReviseError(
    new ApiError(400, 'VALIDATION_ERROR', 'That reply was blocked by the same content checks…', {
      problems: [
        'no_price_commitment: A price in an automated reply is a commitment the business has not agreed to.',
        'no_discount_or_offer: A discount or free work is a concession only a person can make.',
      ],
    }),
  );

  assert.equal(view.kind, 'guardrail');
  assert.equal(view.title, 'Revision blocked by safety checks.');
  assert.deepEqual(view.guardrails, ['no_price_commitment', 'no_discount_or_offer']);
});

test('a lifecycle refusal tells the reviewer the proposal moved on', () => {
  const view = describeReviseError(
    new ApiError(409, 'INVALID_STATE', 'This plan was already approved by sameer and can no longer be edited.', {
      refusedWith: 'approval_not_pending',
    }),
  );

  assert.equal(view.kind, 'lifecycle');
  assert.equal(view.stale, true);
  assert.match(view.message ?? '', /already approved/);
});

test('a network failure says the changes were not saved', () => {
  const view = describeReviseError(new TypeError('fetch failed'));
  assert.equal(view.kind, 'network');
  assert.equal(view.stale, false);
  assert.match(view.message ?? '', /not saved/);
});

test('no error view leaks server internals', () => {
  const views = [
    describeReviseError(new ApiError(500, 'INTERNAL_ERROR', 'boom', { stack: 'at Object.<anonymous>' })),
    describeReviseError(new TypeError('fetch failed')),
    describeReviseError(new ApiError(404, 'NOT_FOUND', 'Decision not found.')),
  ];

  for (const view of views) {
    const serialised = JSON.stringify(view);
    assert.ok(!/stack|at Object|node_modules|INSERT INTO|SELECT /i.test(serialised), serialised);
  }
});

// --- 23, 24  accessibility and layout ---------------------------------------

test('every editable field declares a control that is natively keyboard operable', () => {
  const native = new Set(['text', 'textarea', 'select', 'datetime']);
  const all = [
    ...editableFieldsFor('create_task'),
    ...editableFieldsFor('add_note'),
    ...editableFieldsFor('log_activity'),
  ];

  assert.ok(all.length > 0);
  for (const field of all) {
    assert.ok(native.has(field.control), `${field.field} uses a non-native control`);
    assert.ok(field.label.trim().length > 0, `${field.field} has no label`);
  }
});

test('the edit form labels every control and gives each a visible focus state', () => {
  const source = read('components/reviseForm.tsx');

  assert.match(source, /<label htmlFor=\{id\}/, 'a control is rendered without a real label');
  assert.match(source, /focus-visible:outline/, 'controls have no visible focus state');
  assert.match(source, /aria-invalid/, 'an invalid control is not announced');
  assert.match(source, /aria-live="polite"/, 'errors and successes are not announced');

  // Buttons are buttons, with an explicit type, so Enter and Space both work
  // and the form cannot submit by accident.
  assert.match(source, /type="submit"/);
  assert.match(source, /type="button"/);
});

test('the queue announces state changes and marks its filters as pressed', () => {
  const source = read('screens/Approvals.tsx');
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-pressed=/);
  assert.match(source, /aria-expanded=/);
});

test('no revision surface introduces a fixed width that could overflow a small screen', () => {
  // 375px is the narrowest target. A `w-[Npx]` or `min-w-[Npx]` outside a
  // scroll container is what forces the *page* to scroll sideways, which is the
  // failure this guards against.
  const files = [
    'screens/Approvals.tsx',
    'components/reviseForm.tsx',
    'components/revisionHistory.tsx',
    'components/planDiff.tsx',
  ];

  for (const file of files) {
    const source = read(file);
    const fixed = [...source.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)];

    for (const match of fixed) {
      const width = Number(match[1]);
      if (width <= 375) continue;
      // Permitted only inside a container that scrolls on its own.
      assert.match(
        source,
        /overflow-x-auto/,
        `${file} sets ${match[0]} without an overflow-x-auto container`,
      );
    }

    assert.ok(!/\bw-screen\b/.test(source), `${file} uses w-screen`);
  }
});

test('the wide diff table scrolls inside its own container, not the page', () => {
  const source = read('components/planDiff.tsx');
  const container = source.indexOf('overflow-x-auto');
  const table = source.indexOf('min-w-[');

  assert.ok(container >= 0, 'the diff has no scroll container');
  assert.ok(table > container, 'the wide table is not inside the scroll container');
});

// --- product language -------------------------------------------------------

test('the revision surfaces speak product language, not implementation vocabulary', () => {
  const forbidden = /\b(RAG|embedding|vector|Chroma|retrieval|prompt injection|tool call|token|LLM)\b/i;

  for (const file of ['screens/Approvals.tsx', 'components/reviseForm.tsx', 'components/revisionHistory.tsx']) {
    const source = read(file);
    // Strip comments: the vocabulary rule is about what a client reads.
    const visible = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!forbidden.test(visible), `${file} shows implementation vocabulary to the user`);
  }
});

// --- M4-D  delivery status is never overstated ------------------------------

test('only a server-confirmed send is described as sent', () => {
  const base = {
    id: 'o1',
    toEmail: 'sarah@acmecommerce.invalid',
    subject: 's',
    body: 'b',
    suppressedReason: null,
    providerMessageId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    sentAt: null,
  };

  const sent = presentOutbox({ ...base, status: 'sent', sentAt: '2026-06-01T01:00:00.000Z' });
  assert.equal(sent.delivered, true);
  assert.match(sent.title, /^Sent via/);

  // Every other status must avoid the word entirely.
  for (const status of ['queued', 'suppressed', 'failed'] as const) {
    const view = presentOutbox({ ...base, status });
    assert.equal(view.delivered, false, `${status} claimed delivery`);
    assert.ok(!/\bsent\b/i.test(view.title), `"${view.title}" says sent for a ${status} message`);
  }
});

test('a suppressed reply says outbound sending is disabled', () => {
  const view = presentOutbox({
    id: 'o1',
    toEmail: 'sarah@acmecommerce.invalid',
    subject: 's',
    body: 'b',
    status: 'suppressed',
    suppressedReason: 'outbound_send_disabled',
    providerMessageId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    sentAt: null,
  });

  assert.equal(view.title, 'Outbound sending disabled');
  assert.match(view.detail, /nothing was delivered/i);
  assert.equal(view.tone, 'held');
});

test('a failed delivery says whether retrying would help', () => {
  const make = (reason: string) =>
    presentOutbox({
      id: 'o1',
      toEmail: 'sarah@acmecommerce.invalid',
      subject: 's',
      body: 'b',
      status: 'failed',
      suppressedReason: reason,
      providerMessageId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      sentAt: null,
    });

  assert.match(make('temporary').detail, /can be retried/i);
  assert.match(make('unavailable').detail, /can be retried/i);
  assert.match(make('timeout').detail, /can be retried/i);
  assert.match(make('permanent').detail, /will not help/i);
  assert.match(make('recipient_mismatch').detail, /did not match the approved plan/i);

  for (const reason of ['temporary', 'permanent', 'recipient_mismatch']) {
    assert.equal(make(reason).delivered, false);
  }
});

test('every delivery status carries a non-colour marker', () => {
  const statuses = ['sent', 'queued', 'suppressed', 'failed'] as const;
  const markers = statuses.map((status) =>
    presentOutbox({
      id: 'o1',
      toEmail: 'a@b.co',
      subject: 's',
      body: 'b',
      status,
      suppressedReason: null,
      providerMessageId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      sentAt: null,
    }).marker,
  );

  assert.equal(new Set(markers).size, markers.length, 'two statuses share a marker');
});

test('the approval screen never promises delivery for a plan that is only approved', () => {
  const source = read('screens/Approvals.tsx');
  assert.ok(
    !/never sent in this build/.test(source),
    'the screen still claims nothing can ever be sent, which is no longer true',
  );
  assert.match(source, /outbound sending has been turned on in the server configuration/i);
});

// --- M6-B  the demo must show what actually changed -------------------------

test('an executed action names the record it created', () => {
  // The weakest moment in the demo was an execution list that said
  // "done · Add the company — company". The record is in the snapshot the
  // executor already stores; this reads a name out of it.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['create_company', { id: 'c1', name: 'Acme Commerce', domain: 'acmecommerce.invalid' }, 'Acme Commerce · acmecommerce.invalid'],
    ['create_contact', { id: 'p1', fullName: 'Sarah Williams', email: 'sarah@acmecommerce.invalid' }, 'Sarah Williams · sarah@acmecommerce.invalid'],
    ['create_deal', { id: 'd1', title: 'Acme — AI chatbot', stage: 'new_lead' }, 'Acme — AI chatbot · new_lead'],
    ['log_activity', { id: 'a1', subject: 'Shopify AI chatbot project' }, 'Shopify AI chatbot project'],
  ];

  for (const [actionType, snapshot, expected] of cases) {
    assert.equal(
      describeExecution({ afterSnapshot: snapshot, targetType: actionType }),
      expected,
      `${actionType} was not described`,
    );
  }
});

test('a due date is shown as a date, not an ISO string', () => {
  const described = describeExecution({
    afterSnapshot: { id: 't1', title: 'Follow up with Sarah', dueAt: '2026-08-27T09:00:00.000Z' },
    targetType: 'task',
  });

  assert.match(described ?? '', /^Follow up with Sarah · /);
  assert.ok(!(described ?? '').includes('2026-08-27T'), 'an ISO timestamp was shown to the operator');
});

test('an action with nothing nameable describes nothing rather than guessing', () => {
  // `send_email` stores an empty snapshot. Inventing a label for it would be
  // exactly the wrong kind of helpful in a column a client reads as "what
  // happened to my data".
  for (const snapshot of [null, {}, { id: 'x' }, { count: 3 }, { name: '   ' }]) {
    assert.equal(
      describeExecution({ afterSnapshot: snapshot as Record<string, unknown> | null, targetType: 'outbox' }),
      null,
      `${JSON.stringify(snapshot)} produced an invented label`,
    );
  }
});

test('unbuilt screens do not claim a milestone that already shipped', () => {
  // They said "Arrives in M5". M5 shipped as authentication and outbound
  // safety, and these screens did not come with it — so every one of them was
  // making a claim that had quietly become false.
  const placeholder = read('components/MilestonePlaceholder.tsx');
  const screens = read('screens/placeholders.tsx');

  assert.ok(!/Arrives in \{?milestone/.test(placeholder), 'the placeholder still names a milestone');
  assert.ok(!/milestone:\s*'M\d/.test(screens), 'a screen still declares a milestone');
  assert.match(placeholder, /Not built yet/);

  // And it points at where the same information can be seen today.
  assert.match(placeholder, /availableToday/);
  assert.match(screens, /availableToday:/);
});

test('no screen claims to show data it does not have', () => {
  const screens = read('screens/placeholders.tsx');
  assert.match(screens, /not built/i);
  // The old copy promised "This screen will show"; it now says "when built".
  assert.match(read('components/MilestonePlaceholder.tsx'), /When built, this screen will show/);
});
