import type { ReactNode } from 'react';
import { buildRevisionHistory } from '../revision/approvalPresentation.ts';
import type { DecisionRevision } from '../api/types.ts';

// The decision history (M4-C.3 §3).
//
// The product idea this section carries, without saying it in so many words:
// the assistant proposed something, a person changed it, and the changed
// version is still waiting for that person to approve it. A reviewer who reads
// this list understands the workflow without being told about it.
//
// Every value here comes from the API. Nothing is inferred from the shape of
// the data, because a history the frontend guessed at would look exactly as
// authoritative as one it was told.

const TONE_CLASS: Record<string, string> = {
  waiting: 'bg-signal-tint text-signal',
  done: 'bg-canvas text-ink-muted',
  stopped: 'bg-danger-tint text-danger',
  replaced: 'bg-canvas text-ink-muted',
  none: 'bg-canvas text-ink-muted',
};

export function RevisionHistory({ revisions }: { revisions: DecisionRevision[] }): ReactNode {
  const rows = buildRevisionHistory(revisions);
  if (rows.length <= 1) return null;

  return (
    <section aria-labelledby="revision-history-heading" className="rounded-card border border-line bg-surface p-4">
      <h3 id="revision-history-heading" className="text-eyebrow uppercase tracking-wide text-ink-muted">
        How this proposal changed
      </h3>

      <ol className="mt-3 space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`rounded-control border p-3 ${row.isCurrent ? 'border-brand' : 'border-line'}`}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-small font-semibold text-ink">Revision {row.revision}</span>
              <span className="text-meta text-ink-muted">{row.authorLabel}</span>
              {row.isCurrent ? (
                <span className="rounded-pill bg-brand px-2 py-0.5 text-meta font-semibold text-white">
                  Current
                </span>
              ) : null}
            </div>

            <p className="mt-1 text-meta text-ink-muted">{row.lineageLabel}</p>

            <p className="mt-1 text-meta">
              {/* Marker plus word: the state never depends on colour alone. */}
              <span className={`rounded-pill px-2 py-0.5 font-semibold ${TONE_CLASS[row.tone] ?? TONE_CLASS.none}`}>
                <span aria-hidden="true">{row.stateMarker} </span>
                {row.stateLabel}
              </span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
