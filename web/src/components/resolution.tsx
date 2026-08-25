import type { ReactNode } from 'react';
import type { EntityResolution, ResolutionVerdict } from '../api/types.ts';

// Resolution presentation.
//
// The screen has to make one thing obvious: a conflict is not a failure and not
// a match — it is a question the system is deliberately refusing to answer on
// its own. So a conflict renders as a choice with both candidates and their
// evidence side by side, rather than as an error.

export function VerdictChip({ verdict }: { verdict: ResolutionVerdict }): ReactNode {
  const label =
    verdict === 'MATCH' ? 'Matched' : verdict === 'MATCH_CONFLICT' ? 'Needs a decision' : 'New record';
  const tone =
    verdict === 'MATCH'
      ? 'bg-success-tint text-success'
      : verdict === 'MATCH_CONFLICT'
        ? 'bg-danger-tint text-danger'
        : 'bg-canvas text-ink-muted border border-line-strong';

  return <span className={`inline-flex rounded-pill px-2 py-0.5 text-meta font-semibold ${tone}`}>{label}</span>;
}

const METHOD_LABELS: Record<string, string> = {
  exact_email: 'exact email address',
  exact_domain: 'exact domain',
  domain_and_exact_name: 'same domain and name',
  domain_and_fuzzy_name: 'same domain, similar name',
  exact_name_norm: 'same company name',
  fuzzy_name: 'similar company name',
  distinctive_token: 'shared distinctive name',
  name_only: 'name only',
  thread: 'earlier email in this thread',
};

export function ResolutionCard({
  title,
  resolution,
  onChoose,
  busy,
}: {
  title: string;
  resolution: EntityResolution;
  onChoose?: (entityId: string | null) => void;
  busy?: boolean;
}): ReactNode {
  const isConflict = resolution.verdict === 'MATCH_CONFLICT';

  return (
    <section
      className={`rounded-card border bg-surface p-4 shadow-resting ${
        isConflict ? 'border-danger' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-small font-semibold">{title}</h4>
        <VerdictChip verdict={resolution.verdict} />
      </div>

      <p className="mt-2 text-small text-ink-muted">{resolution.reason}</p>

      {resolution.candidates.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {resolution.candidates.map((candidate) => (
            <li
              key={candidate.entityId}
              className={`rounded-control border p-3 ${
                candidate.entityId === resolution.selectedEntityId ? 'border-success bg-success-tint' : 'border-line'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-small font-semibold">{candidate.label}</span>
                <span className="font-mono text-meta text-ink-muted">
                  {candidate.score.toFixed(2)} · {METHOD_LABELS[candidate.method] ?? candidate.method}
                </span>
              </div>
              <p className="mt-1 text-meta text-ink-muted">{candidate.evidence}</p>

              {isConflict && onChoose ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChoose(candidate.entityId)}
                  className="mt-2 h-control rounded-control border border-line-strong px-3 text-meta font-semibold disabled:opacity-50"
                >
                  This is the right one
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {isConflict && onChoose ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose(null)}
          className="mt-3 h-control rounded-control border border-line-strong px-3 text-meta font-semibold disabled:opacity-50"
        >
          Neither — this is a new record
        </button>
      ) : null}
    </section>
  );
}
