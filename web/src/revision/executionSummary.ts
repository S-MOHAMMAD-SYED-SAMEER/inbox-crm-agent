import type { Execution } from '../api/types.ts';

// What an executed action actually did (M6-B).
//
// The execution list used to read "done · Add the company — company": the action
// and the *type* of thing it touched, but never the thing itself. On a demo that
// is the weakest moment in the whole flow — the point where a client should see
// their CRM change, and instead sees a word they already knew.
//
// The record it created is already in `afterSnapshot`, returned by the API and
// stored precisely so a change is inspectable afterwards. This reads a name out
// of it.
//
// IT NEVER INVENTS ANYTHING. If the snapshot has no recognisable name the
// summary is null and the UI falls back to what it showed before. A plausible
// guess in a column a client reads as "what happened to my data" would be
// exactly the wrong kind of helpful.

/** Fields worth showing, in the order they identify a record to a person. */
const NAME_FIELDS = ['name', 'fullName', 'title', 'subject'] as const;

/** Secondary detail, shown after the name when present. */
const DETAIL_FIELDS = ['domain', 'email', 'stage', 'dueAt', 'priority'] as const;

function readString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * A short, human description of what one execution produced.
 *
 * Returns null when the record cannot be named — the caller then shows the
 * action alone rather than a placeholder.
 */
export function describeExecution(execution: Pick<Execution, 'afterSnapshot' | 'targetType'>): string | null {
  const snapshot = execution.afterSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;

  const record = snapshot as Record<string, unknown>;

  const name = NAME_FIELDS.map((field) => readString(record, field)).find((value) => value !== null) ?? null;
  if (name === null) return null;

  const detail = DETAIL_FIELDS.map((field) => readString(record, field)).find((value) => value !== null) ?? null;

  // A due date reads as a date, not as an ISO string nobody parses at a glance.
  const formatted =
    detail !== null && /^\d{4}-\d{2}-\d{2}T/.test(detail)
      ? new Date(detail).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : detail;

  return formatted === null ? name : `${name} · ${formatted}`;
}
