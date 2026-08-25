import { DRAFT_FIELDS, currentValue, editableFieldsFor } from './editableFields.ts';
import type { ActionPlan, EditEnvelope, ProposedAction } from '../api/types.ts';

// The edit form's state, and what it turns into.
//
// Held as strings keyed by path, because that is what form controls produce and
// because it keeps the comparison honest: "did this field change?" is answered
// against the value the reviewer actually sees, not against a parsed
// round-trip that might differ from it invisibly.
//
// TWO THINGS THIS MODULE WILL NOT DO
//
//   * It will not send an unchanged field. The server refuses a no-op revision
//     outright, and more importantly every path in the envelope reads as a
//     deliberate change by the reviewer.
//   * It will not guess whether the server will accept the result. The summary
//     below says what the reviewer changed, never what will happen to it.

export type EditDraft = Record<string, string>;

export type ChangeRow = {
  path: string;
  /** "Draft · Message", "Schedule a follow-up · Priority" — reads as a sentence. */
  label: string;
  before: string;
  after: string;
};

export const DRAFT_PREFIX = 'draft';

export function draftPath(field: string): string {
  return `${DRAFT_PREFIX}.${field}`;
}

export function actionPath(index: number, field: string): string {
  return `actions.${index}.${field}`;
}

/**
 * The form's starting state: every editable field, at its current value.
 *
 * Built from the plan rather than accumulated as the reviewer types, so opening
 * the editor twice gives the same starting point and "changed" always means
 * changed relative to the proposal.
 */
export function initialEditDraft(plan: ActionPlan): EditDraft {
  const draft: EditDraft = {};

  if (plan.draft !== null) {
    for (const field of DRAFT_FIELDS) {
      draft[draftPath(field.field)] = plan.draft[field.field as 'subject' | 'body'];
    }
  }

  plan.actions.forEach((action, index) => {
    for (const field of editableFieldsFor(action.type)) {
      draft[actionPath(index, field.field)] = currentValue(action, field.field);
    }
  });

  return draft;
}

function labelFor(plan: ActionPlan, path: string, actionLabelOf: (type: string) => string): string {
  const [scope, second, third] = path.split('.');

  if (scope === DRAFT_PREFIX) {
    const field = DRAFT_FIELDS.find((entry) => entry.field === second);
    return `Reply · ${field?.label ?? second}`;
  }

  const index = Number(second);
  const action = plan.actions[index];
  if (!action) return path;
  const field = editableFieldsFor(action.type).find((entry) => entry.field === third);
  return `${actionLabelOf(action.type)} · ${field?.label ?? third}`;
}

/**
 * What the reviewer changed, in the order the plan presents it.
 *
 * Only fields whose value actually differs. An unchanged field in a "changes"
 * list trains people to skim the list, which defeats the point of having one.
 */
export function summariseChanges(
  plan: ActionPlan,
  edited: EditDraft,
  actionLabelOf: (type: string) => string,
): ChangeRow[] {
  const original = initialEditDraft(plan);
  const rows: ChangeRow[] = [];

  for (const path of Object.keys(original)) {
    const before = original[path] ?? '';
    const after = edited[path] ?? '';
    if (before === after) continue;
    rows.push({ path, label: labelFor(plan, path, actionLabelOf), before, after });
  }

  return rows;
}

export function hasChanges(plan: ActionPlan, edited: EditDraft): boolean {
  return summariseChanges(plan, edited, (type) => type).length > 0;
}

/**
 * Whether the submit button may fire.
 *
 * Pulled out of the component so the guard is testable, because the thing it
 * prevents is a double-submit creating two revisions from one intent — and the
 * second would supersede the first, leaving a confusing history nobody asked
 * for.
 */
export function canSubmit(input: { submitting: boolean; changeCount: number }): boolean {
  return !input.submitting && input.changeCount > 0;
}

/**
 * The request body for `POST /decisions/:id/revise`.
 *
 * Carries only changed paths, in the shape M4-C.2 defined. A nullable field
 * emptied by the reviewer is sent as `null` rather than `""` — the server
 * rejects an empty string, and "no details" is a legitimate thing to mean.
 */
export function buildEditEnvelope(plan: ActionPlan, edited: EditDraft): EditEnvelope {
  const envelope: EditEnvelope = {};
  const changes = summariseChanges(plan, edited, (type) => type);

  for (const change of changes) {
    const [scope, second, third] = change.path.split('.');

    if (scope === DRAFT_PREFIX) {
      envelope.draft = { ...envelope.draft, [second as string]: change.after };
      continue;
    }

    const index = Number(second);
    const action = plan.actions[index] as ProposedAction | undefined;
    if (!action) continue;

    const field = editableFieldsFor(action.type).find((entry) => entry.field === third);
    const value = field?.nullable && change.after.trim() === '' ? null : change.after;

    envelope.actions = [
      ...(envelope.actions ?? []),
      // `type` is an assertion, not a setting: the server checks it against the
      // action at that index and can only ever refuse because of it. It makes a
      // stale screen fail loudly instead of editing the wrong action.
      { index, field: third as string, value, type: action.type },
    ];
  }

  return envelope;
}
