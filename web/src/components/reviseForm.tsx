import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  DRAFT_FIELDS,
  actionLabel,
  editableFieldsFor,
  isEditableAction,
  NOT_EDITABLE_REASON,
  type EditableField,
} from '../revision/editableFields.ts';
import {
  actionPath,
  buildEditEnvelope,
  draftPath,
  canSubmit,
  initialEditDraft,
  summariseChanges,
  type EditDraft,
} from '../revision/editState.ts';
import { describeReviseError, problemPath, type ReviseErrorView } from '../revision/reviseErrors.ts';
import { api, ApiError } from '../api/client.ts';
import type { ActionPlan, RevisionResult } from '../api/types.ts';

// The edit form (M4-C.3 §4–§10).
//
// A reviewer changes the words. They never change what the plan *does*.
//
// That distinction is the whole shape of this component. Fields the assistant
// wrote — a reply, a task title, a note — get real typed controls. Everything
// that decides who gets contacted, what a deal is worth, or where it sits in
// the pipeline gets a sentence explaining that it is not editable here, and no
// control at all. A disabled input would invite the question "why not?" and
// then invite someone to find a way round it.
//
// The server is still the authority. This form can produce only edits the API
// has a rule for, but the API re-checks every one of them, re-runs the safety
// checks on any edited reply, and re-derives whether a human is still needed.
// Nothing below grants anything.

type Props = {
  decisionId: string;
  plan: ActionPlan;
  onCancel(): void;
  onRevised(result: RevisionResult): void;
};

function characterCount(value: string, max: number | undefined): string | null {
  if (max === undefined) return null;
  return `${value.length} / ${max}`;
}

/** One control, chosen by the field's declared type. */
function Field({
  field,
  path,
  value,
  invalid,
  onChange,
}: {
  field: EditableField;
  path: string;
  value: string;
  invalid: string | null;
  onChange(next: string): void;
}): ReactNode {
  const id = `edit-${path.replace(/\./g, '-')}`;
  const describedBy = [field.hint ? `${id}-hint` : null, invalid ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  const shared = {
    id,
    value,
    'aria-invalid': invalid ? (true as const) : undefined,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    className: `mt-1 w-full rounded-control border bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
      invalid ? 'border-danger' : 'border-line'
    }`,
  };

  return (
    <div className="mt-3">
      <label htmlFor={id} className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
        {field.label}
      </label>

      {field.control === 'textarea' ? (
        <textarea
          {...shared}
          rows={field.maxLength && field.maxLength > 1000 ? 8 : 3}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.control === 'select' ? (
        <select {...shared} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.control === 'datetime' ? (
        <input
          {...shared}
          type="datetime-local"
          // The API speaks ISO-8601; the control speaks local time without a
          // zone. Converting at the edges keeps one format in the payload.
          value={value === '' ? '' : toLocalInput(value)}
          onChange={(event) => onChange(fromLocalInput(event.target.value))}
        />
      ) : (
        <input {...shared} type="text" maxLength={field.maxLength} onChange={(event) => onChange(event.target.value)} />
      )}

      <div className="mt-1 flex flex-wrap justify-between gap-2">
        {field.hint ? (
          <span id={`${id}-hint`} className="text-meta text-ink-muted">
            {field.hint}
          </span>
        ) : (
          <span />
        )}
        {characterCount(value, field.maxLength) ? (
          <span className="text-meta text-ink-muted">{characterCount(value, field.maxLength)}</span>
        ) : null}
      </div>

      {invalid ? (
        <p id={`${id}-error`} className="mt-1 text-meta font-semibold text-danger">
          {invalid}
        </p>
      ) : null}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const date = new Date(parsed - new Date(parsed).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function fromLocalInput(local: string): string {
  if (local === '') return '';
  const parsed = Date.parse(local);
  return Number.isNaN(parsed) ? local : new Date(parsed).toISOString();
}

export function ReviseForm({ decisionId, plan, onCancel, onRevised }: Props): ReactNode {
  const [edited, setEdited] = useState<EditDraft>(() => initialEditDraft(plan));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReviseErrorView | null>(null);
  const statusId = useId();

  const changes = useMemo(() => summariseChanges(plan, edited, actionLabel), [plan, edited]);

  const fieldErrors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const problem of error?.problems ?? []) {
      const path = problemPath(problem);
      if (path) map[path] = problem;
    }
    return map;
  }, [error]);

  const set = (path: string, value: string): void => setEdited((current) => ({ ...current, [path]: value }));

  const submit = async (): Promise<void> => {
    if (!canSubmit({ submitting, changeCount: changes.length })) return;
    setSubmitting(true);
    setError(null);

    try {
      const result = await api.revise(decisionId, buildEditEnvelope(plan, edited));
      onRevised(result);
    } catch (err) {
      setError(describeReviseError(err instanceof ApiError ? err : err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {plan.draft !== null ? (
        <fieldset className="rounded-card border border-line bg-surface p-4">
          <legend className="px-1 text-small font-semibold text-ink">The reply</legend>
          {DRAFT_FIELDS.map((field) => (
            <Field
              key={field.field}
              field={field}
              path={draftPath(field.field)}
              value={edited[draftPath(field.field)] ?? ''}
              invalid={fieldErrors[draftPath(field.field)] ?? null}
              onChange={(next) => set(draftPath(field.field), next)}
            />
          ))}
          <p className="mt-3 text-meta text-ink-muted">
            Edits are checked again before a new approval is created.
          </p>
        </fieldset>
      ) : null}

      <fieldset className="rounded-card border border-line bg-surface p-4">
        <legend className="px-1 text-small font-semibold text-ink">What will be recorded</legend>

        {plan.actions.map((action, index) => {
          const fields = editableFieldsFor(action.type);

          return (
            <div key={`${action.type}-${index}`} className="mt-3 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="text-small font-semibold text-ink">{actionLabel(action.type)}</p>

              {isEditableAction(action.type) ? (
                fields.map((field) => (
                  <Field
                    key={field.field}
                    field={field}
                    path={actionPath(index, field.field)}
                    value={edited[actionPath(index, field.field)] ?? ''}
                    invalid={fieldErrors[`actions.${index}`] ?? null}
                    onChange={(next) => set(actionPath(index, field.field), next)}
                  />
                ))
              ) : (
                <>
                  <p className="mt-1 text-meta font-semibold text-ink-muted">Not editable</p>
                  <p className="mt-0.5 text-meta text-ink-muted">{NOT_EDITABLE_REASON}</p>
                </>
              )}
            </div>
          );
        })}
      </fieldset>

      {changes.length > 0 ? (
        <section aria-labelledby="change-summary-heading" className="rounded-card border border-line bg-canvas p-4">
          <h4 id="change-summary-heading" className="text-eyebrow uppercase tracking-wide text-ink-muted">
            Changes to proposal
          </h4>
          <dl className="mt-2 space-y-3">
            {changes.map((change) => (
              <div key={change.path}>
                <dt className="text-small font-semibold text-ink">{change.label}</dt>
                <dd className="mt-1 space-y-1 text-meta">
                  <p className="text-ink-muted">
                    <span className="font-semibold">Before: </span>
                    <span className="whitespace-pre-wrap break-words line-through">{change.before || '(empty)'}</span>
                  </p>
                  <p className="text-ink">
                    <span className="font-semibold">After: </span>
                    <span className="whitespace-pre-wrap break-words">{change.after || '(empty)'}</span>
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <div aria-live="polite" id={statusId}>
        {error ? (
          <div className="rounded-card border border-danger bg-danger-tint p-4">
            <p className="text-small font-semibold text-danger">{error.title}</p>
            {error.message ? <p className="mt-1 text-small text-ink-muted">{error.message}</p> : null}

            {error.guardrails.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {error.guardrails.map((guardrail) => (
                  <li key={guardrail} className="text-meta text-ink-muted">
                    {guardrail.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            ) : null}

            {error.problems.length > 0 && error.guardrails.length === 0 ? (
              <ul className="mt-2 space-y-0.5">
                {error.problems.map((problem) => (
                  <li key={problem} className="text-meta text-ink-muted">
                    {problem}
                  </li>
                ))}
              </ul>
            ) : null}

            {error.stale ? (
              <p className="mt-2 text-meta text-ink-muted">Reload the page to see where it got to.</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!canSubmit({ submitting, changeCount: changes.length })}
          className="h-control rounded-control bg-brand px-4 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit revision'}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="h-control rounded-control border border-line-strong px-4 text-small font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          Cancel
        </button>

        {changes.length === 0 ? (
          <span className="text-meta text-ink-muted">Change something to submit a revision.</span>
        ) : null}
      </div>
    </form>
  );
}
