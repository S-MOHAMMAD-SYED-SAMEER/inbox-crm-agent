import type { ProposedAction } from '../api/types.ts';

// What the edit form is allowed to render.
//
// This mirrors the server's whitelist (M4-C.2 `editEnvelope.ts`) for one narrow
// purpose: knowing which typed control to draw. It is NOT a second copy of the
// validation rules, and it must never become one — the server decides what is
// acceptable, and a revision it refuses is refused no matter what this file
// thinks.
//
// WHY A DESCRIPTOR RATHER THAN A GENERIC JSON EDITOR
//
// A JSON editor would let a reviewer type anything into any field and find out
// afterwards. It would also expose the shape of the database to a person whose
// job is to check a business decision. Each field below names its control, its
// label and its limit, so the form can only produce edits the server has a rule
// for — and so a reviewer sees "Due" and a date picker, not `dueAt` and a
// string.
//
// Anything absent from this file is not editable. There are no disabled
// controls for immutable fields: a control that cannot be used is a worse
// answer than an honest sentence saying why.

export type FieldControl = 'text' | 'textarea' | 'datetime' | 'select';

export type EditableField = {
  field: string;
  label: string;
  control: FieldControl;
  /** Matches the server's limit, so the counter and the server agree. */
  maxLength?: number;
  options?: readonly string[];
  nullable?: boolean;
  /** Shown under the control when it helps. */
  hint?: string;
};

export const PRIORITIES = ['high', 'medium', 'low'] as const;

export const MAX_SUBJECT = 200;
export const MAX_BODY = 4000;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 2000;

export const DRAFT_FIELDS: readonly EditableField[] = Object.freeze([
  { field: 'subject', label: 'Subject', control: 'text', maxLength: MAX_SUBJECT },
  { field: 'body', label: 'Message', control: 'textarea', maxLength: MAX_BODY },
]);

const ACTION_FIELDS: Readonly<Record<string, readonly EditableField[]>> = Object.freeze({
  create_task: [
    { field: 'title', label: 'Task', control: 'text', maxLength: MAX_TITLE },
    {
      field: 'description',
      label: 'Details',
      control: 'textarea',
      maxLength: MAX_DESCRIPTION,
      nullable: true,
    },
    { field: 'dueAt', label: 'Due', control: 'datetime', hint: 'Must be in the future.' },
    { field: 'priority', label: 'Priority', control: 'select', options: PRIORITIES },
  ],
  add_note: [{ field: 'body', label: 'Note', control: 'textarea', maxLength: MAX_BODY }],
  log_activity: [
    { field: 'subject', label: 'Summary', control: 'text', maxLength: MAX_SUBJECT },
    { field: 'body', label: 'Detail', control: 'textarea', maxLength: MAX_BODY },
  ],
});

/** Human-readable names for every action, editable or not. */
export const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  create_company: 'Add the company',
  create_contact: 'Add the contact',
  link_contact_to_company: 'Link contact to company',
  log_activity: 'Record on the timeline',
  add_note: 'Add an internal note',
  create_deal: 'Open a deal',
  update_deal_stage: 'Move the deal',
  update_deal_amount: 'Change the deal value',
  create_task: 'Schedule a follow-up',
  archive_email: 'Archive the email',
  send_email: 'Send the reply',
});

/**
 * Why an action cannot be edited here.
 *
 * Deliberately the same sentence for all of them, and deliberately not a hint
 * about how to get around it: these actions decide who is contacted, what a
 * deal is worth and where it sits in the pipeline, and changing those from an
 * approval screen would route around the stage that worked them out.
 */
export const NOT_EDITABLE_REASON =
  'This action must be changed by creating a new agent decision, not by editing the existing plan.';

export function editableFieldsFor(actionType: string): readonly EditableField[] {
  return ACTION_FIELDS[actionType] ?? [];
}

export function isEditableAction(actionType: string): boolean {
  return editableFieldsFor(actionType).length > 0;
}

export function actionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType.replace(/_/g, ' ');
}

/** The current value of one editable field, as a string the form can hold. */
export function currentValue(action: ProposedAction, field: string): string {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const value = payload[field];
  if (value === null || value === undefined) return '';
  return String(value);
}
