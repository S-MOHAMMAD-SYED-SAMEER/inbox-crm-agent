import type { ReactNode } from 'react';
import { reviewReasonLabel, stateLabel, type StateTone } from '../inbox/statePresentation.ts';

// Small presentational pieces shared by the Inbox and the email detail screen.
//
// One rule runs through all of them: **status is never carried by colour
// alone** (NFR-11). Every chip states its meaning in words; the colour is a
// second channel, not the only one.

export function ConfidenceBadge({
  band,
  confidence,
}: {
  band: 'high' | 'medium' | 'low';
  confidence: number;
}): ReactNode {
  // The band is what changes system behaviour; the number alone invites false
  // precision, so both are always shown together (§13.3).
  const tone =
    band === 'high'
      ? 'bg-success-tint text-success'
      : band === 'medium'
        ? 'bg-signal-tint text-signal'
        : 'bg-danger-tint text-danger';

  return (
    <span className={`inline-flex items-baseline gap-1.5 rounded-pill px-2 py-0.5 text-meta font-semibold ${tone}`}>
      <span className="capitalize">{band}</span>
      <span className="font-mono opacity-80">{confidence.toFixed(2)}</span>
    </span>
  );
}

const STATE_TONE_CLASS: Record<StateTone, string> = {
  done: 'border-success text-success',
  failed: 'border-danger text-danger',
  attention: 'border-signal text-signal',
  working: 'border-line-strong text-ink-muted',
};

export function StateChip({ state, reviewReason }: { state: string; reviewReason?: string | null }): ReactNode {
  // Plain language and a corrected tone, from `inbox/statePresentation.ts`.
  // This used to print the database enum with its underscores stripped, and to
  // colour a transient state green while a failed execution stayed grey.
  const presentation = stateLabel(state);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-meta ${
        STATE_TONE_CLASS[presentation.tone]
      }`}
    >
      <span aria-hidden="true">{presentation.marker}</span>
      <span>{presentation.label}</span>
      {reviewReason ? <span className="opacity-75">· {reviewReasonLabel(reviewReason)}</span> : null}
    </span>
  );
}

export function CategoryChip({ category }: { category: string }): ReactNode {
  return (
    <span className="inline-flex rounded-pill bg-brand-tint px-2 py-0.5 text-meta font-semibold capitalize text-brand">
      {category.replace(/_/g, ' ')}
    </span>
  );
}

export function PriorityChip({ priority }: { priority: string }): ReactNode {
  return (
    <span className="inline-flex rounded-pill border border-line-strong px-2 py-0.5 text-meta capitalize text-ink-muted">
      {priority} priority
    </span>
  );
}

/**
 * Finds where a source span sits in the email body.
 *
 * Tries an exact match first, then a whitespace-flexible one — a model quoting
 * from a wrapped email will not reproduce its line breaks, and failing to
 * highlight a correct span would make the provenance feature look broken
 * exactly when it is working.
 */
export function findSpanRange(body: string, span: string): [number, number] | null {
  const exact = body.indexOf(span);
  if (exact !== -1) return [exact, exact + span.length];

  const escaped = span.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = new RegExp(escaped, 'i').exec(body);
  return match ? [match.index, match.index + match[0].length] : null;
}

/**
 * The email body with one span highlighted.
 *
 * This is the most persuasive interaction in the product: hovering an extracted
 * field lights up the exact text it came from, which *shows* rather than claims
 * that the value was not invented.
 */
export function EmailBody({ body, highlight }: { body: string; highlight: string | null }): ReactNode {
  const range = highlight ? findSpanRange(body, highlight) : null;

  if (!range) {
    return <pre className="whitespace-pre-wrap font-sans text-small leading-relaxed text-ink">{body}</pre>;
  }

  return (
    <pre className="whitespace-pre-wrap font-sans text-small leading-relaxed text-ink">
      {body.slice(0, range[0])}
      <mark className="rounded bg-brand-tint px-0.5 text-brand">{body.slice(range[0], range[1])}</mark>
      {body.slice(range[1])}
    </pre>
  );
}
