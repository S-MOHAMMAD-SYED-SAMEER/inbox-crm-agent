import { ProblemCollector, requireObject } from '../../lib/validate.ts';
import { PRIORITIES } from '../../domain/email.ts';
import type { ActionPlan, Draft } from '../../domain/decision.ts';
import type { ProposedAction } from '../../domain/actions.ts';

// The editable surface (M4-C, FR-23).
//
// THIS FILE IS A WHITELIST, AND THAT IS THE ENTIRE SECURITY MODEL OF IT.
//
// A blacklist of forbidden fields is wrong here for a reason that is easy to
// state and expensive to discover: the next payload field somebody adds to an
// action would be editable by default. Every field starts immutable, and the
// only way one becomes editable is by being written down below, next to the
// rule that says what a valid value for it looks like.
//
// WHAT IS EDITABLE, AND WHY ONLY THIS
//
// Human *content*, never targeting and never business state. A reviewer may
// rewrite the words in a note, a task or a reply. They may not change which
// contact it attaches to, which deal moves, what a deal is worth, or who a
// reply goes to — those came from entity resolution and the rules engine, and
// editing them from an approval screen would route around the stage that
// produced them and the audit trail that explains them.
//
// So `create_contact.email`, `send_email.toEmail`, `create_deal.stage`,
// `update_deal_amount.amountMinor`, every `EntityRef`, and the action type
// itself are all absent from the table below. Not blocked — absent. There is no
// code path that would accept them.

/** Everything the model wrote that a person may rewrite. */
export const EDITABLE_DRAFT_FIELDS = ['subject', 'body'] as const;
export type EditableDraftField = (typeof EDITABLE_DRAFT_FIELDS)[number];

type ValueRule = (value: unknown, path: string, problems: ProblemCollector, now: string) => unknown;

const MAX_SUBJECT = 200;
const MAX_BODY = 4000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

function text(max: number, options: { nullable?: boolean } = {}): ValueRule {
  return (value, path, problems) => {
    if (value === null && options.nullable) return null;
    if (typeof value !== 'string') {
      problems.add(`"${path}" must be a string${options.nullable ? ' or null' : ''}`);
      return null;
    }
    if (value.trim() === '') {
      problems.add(`"${path}" must not be empty`);
      return null;
    }
    if (value.length > max) {
      problems.add(`"${path}" must be at most ${max} characters (received ${value.length})`);
      return null;
    }
    return value;
  };
}

/**
 * A due date has to be a real instant and it has to be ahead of us.
 *
 * A follow-up task dated in the past is not a follow-up — it arrives already
 * overdue, and the operator who edited it would have created the exact silent
 * failure the task existed to prevent.
 */
const futureIsoTimestamp: ValueRule = (value, path, problems, now) => {
  if (typeof value !== 'string') {
    problems.add(`"${path}" must be an ISO-8601 timestamp`);
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    problems.add(`"${path}" must be an ISO-8601 timestamp (received "${value}")`);
    return null;
  }
  if (parsed <= Date.parse(now)) {
    problems.add(`"${path}" must be in the future`);
    return null;
  }
  return new Date(parsed).toISOString();
};

const priority: ValueRule = (value, path, problems) => {
  if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
    problems.add(`"${path}" must be one of: ${PRIORITIES.join(', ')}`);
    return null;
  }
  return value;
};

/**
 * The whitelist itself.
 *
 * An action type absent from this map has no editable fields at all — which is
 * the case for every tier-2 action, and deliberately so.
 */
export const EDITABLE_ACTION_FIELDS: Readonly<Record<string, Readonly<Record<string, ValueRule>>>> = Object.freeze({
  create_task: Object.freeze({
    title: text(MAX_TITLE),
    description: text(MAX_DESCRIPTION, { nullable: true }),
    dueAt: futureIsoTimestamp,
    priority,
  }),
  add_note: Object.freeze({
    body: text(MAX_BODY),
  }),
  log_activity: Object.freeze({
    subject: text(MAX_SUBJECT),
    body: text(MAX_BODY),
  }),
});

/** One field of one action, changed. */
export type ActionEdit = {
  index: number;
  field: string;
  value: unknown;
};

export type EditDiffEntry = {
  path: string;
  actionIndex: number | null;
  actionType: string | null;
  field: string;
  before: unknown;
  after: unknown;
};

export type ValidatedEdits = {
  /** The full action list, with edits applied. Same length, same order, same types. */
  actions: ProposedAction[];
  /** The draft with edits applied, or the original when the draft was untouched. */
  draft: Draft | null;
  draftEdited: boolean;
  diff: EditDiffEntry[];
};

const ALLOWED_ENVELOPE_KEYS = new Set(['draft', 'actions']);
const ALLOWED_ACTION_EDIT_KEYS = new Set(['index', 'field', 'value', 'type']);

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  problems: ProblemCollector,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      problems.add(`"${path}.${key}" is not something an edit may set`);
    }
  }
}

/**
 * Validates an edit envelope against the plan it claims to edit.
 *
 * Everything is checked before anything is built, and the collector reports
 * every problem rather than the first — a malformed edit should be one round
 * trip to fix, not five.
 *
 * The plan is an input rather than a shape to be replaced: edits address
 * existing actions by index and field, so an action cannot be added, removed,
 * reordered or retyped. Those are not rejected by a rule; they are unsayable in
 * this vocabulary, which is a stronger guarantee than a rule would be.
 */
export function validateEditEnvelope(input: unknown, plan: ActionPlan, now: string): ValidatedEdits {
  const problems = new ProblemCollector();
  const envelope = requireObject(input, 'edits', problems);
  rejectUnknownKeys(envelope, ALLOWED_ENVELOPE_KEYS, 'edits', problems);

  const actions: ProposedAction[] = plan.actions.map((action) => ({
    ...action,
    payload: action.payload === null ? null : { ...(action.payload as Record<string, unknown>) },
  })) as ProposedAction[];

  const diff: EditDiffEntry[] = [];

  // --- draft -----------------------------------------------------------------

  let draft: Draft | null = plan.draft;
  let draftEdited = false;

  if (envelope.draft !== undefined) {
    const requested = requireObject(envelope.draft, 'edits.draft', problems);
    rejectUnknownKeys(requested, new Set(EDITABLE_DRAFT_FIELDS), 'edits.draft', problems);

    if (plan.draft === null) {
      problems.add('"edits.draft" cannot be edited because this plan has no drafted reply');
    } else {
      const edited = { ...plan.draft };

      for (const field of EDITABLE_DRAFT_FIELDS) {
        if (requested[field] === undefined) continue;

        const max = field === 'subject' ? MAX_SUBJECT : MAX_BODY;
        const value = text(max)(requested[field], `edits.draft.${field}`, problems, now);
        if (typeof value !== 'string') continue;
        if (value === plan.draft[field]) continue;

        diff.push({
          path: `draft.${field}`,
          actionIndex: null,
          actionType: null,
          field,
          before: plan.draft[field],
          after: value,
        });
        edited[field] = value;
        draftEdited = true;
      }

      if (draftEdited) draft = edited;
    }
  }

  // --- actions ---------------------------------------------------------------

  if (envelope.actions !== undefined) {
    if (!Array.isArray(envelope.actions)) {
      problems.add('"edits.actions" must be an array of { index, field, value } edits');
    } else {
      const seen = new Set<string>();

      envelope.actions.forEach((raw, position) => {
        const path = `edits.actions[${position}]`;
        const edit = requireObject(raw, path, problems);
        rejectUnknownKeys(edit, ALLOWED_ACTION_EDIT_KEYS, path, problems);

        if (edit.index === undefined) {
          problems.add(`"${path}.index" is required — an edit must say which action it changes`);
          return;
        }
        if (typeof edit.index !== 'number' || !Number.isInteger(edit.index)) {
          problems.add(`"${path}.index" must be a whole number`);
          return;
        }
        if (edit.index < 0 || edit.index >= plan.actions.length) {
          problems.add(
            `"${path}.index" is out of range: this plan has ${plan.actions.length} action(s), ` +
              'and an edit can never add or remove one',
          );
          return;
        }

        const target = plan.actions[edit.index] as ProposedAction;

        // An optional assertion, not a setting: it lets a caller prove the index
        // still means what it meant when the plan was rendered, and it can only
        // ever cause a refusal.
        if (edit.type !== undefined && edit.type !== target.type) {
          problems.add(
            `"${path}.type" says "${String(edit.type)}" but action ${edit.index} is "${target.type}"`,
          );
          return;
        }

        if (typeof edit.field !== 'string' || edit.field === '') {
          problems.add(`"${path}.field" is required and must be a string`);
          return;
        }

        const key = `${edit.index}.${edit.field}`;
        if (seen.has(key)) {
          problems.add(`"${path}" edits ${target.type}.${edit.field} twice — an edit must have one final value`);
          return;
        }
        seen.add(key);

        const editable = EDITABLE_ACTION_FIELDS[target.type];
        const rule = editable?.[edit.field];

        if (!rule) {
          const payload = (target.payload ?? {}) as Record<string, unknown>;
          // "Immutable" and "unknown" are different mistakes and deserve
          // different sentences: one is a field the reviewer can see and may not
          // change, the other is a field that does not exist.
          problems.add(
            Object.hasOwn(payload, edit.field)
              ? `"${target.type}.${edit.field}" is not editable`
              : `"${target.type}.${edit.field}" is not a field of that action`,
          );
          return;
        }

        const value = rule(edit.value, `${path}.value`, problems, now);
        if (value === null && edit.value !== null) return;

        const payload = (actions[edit.index] as ProposedAction).payload as Record<string, unknown>;
        const before = payload[edit.field] ?? null;
        if (before === value) return;

        diff.push({
          path: `actions[${edit.index}].${edit.field}`,
          actionIndex: edit.index,
          actionType: target.type,
          field: edit.field,
          before,
          after: value,
        });
        payload[edit.field] = value;
      });
    }
  }

  problems.throwIfAny('This edit could not be applied.');

  if (diff.length === 0) {
    // A revision that changes nothing would still supersede the pending
    // approval and restart the SLA clock — real consequences for no reason.
    problems.add('This edit changes nothing, so there is nothing to revise');
    problems.throwIfAny('This edit could not be applied.');
  }

  return { actions, draft, draftEdited, diff };
}
