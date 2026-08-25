import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { presentSource } from '../crm/presentation.ts';
import type { RecordSource } from '../api/types.ts';

// The shared shell for every CRM list (M6-C).
//
// Five screens with the same three states — loading, empty, error — written five
// times would drift, and the one that drifts is always the error state nobody
// looks at until a demo. One component owns them.
//
// LOADING AND EMPTY MUST NOT LOOK LIKE FAILURE
//
// A blank panel reads as broken. Loading says it is loading; empty says what
// would appear here and why nothing has yet — which, on a fresh demo, is simply
// that no email has been processed. An error says what failed in a sentence a
// client can hear, and never shows a stack, a code, or a URL.

const TONE_CLASS: Record<string, string> = {
  agent: 'bg-brand text-white',
  human: 'bg-canvas text-ink-muted border border-line-strong',
  seed: 'bg-canvas text-ink-muted border border-line',
};

/** The badge that makes agent-created records identifiable at a glance. */
export function SourceBadge({ source }: { source: RecordSource }): ReactNode {
  const presentation = presentSource(source);
  return (
    <span
      title={presentation.description}
      className={`inline-block whitespace-nowrap rounded-pill px-2 py-0.5 text-meta font-semibold ${
        TONE_CLASS[presentation.tone] ?? TONE_CLASS.seed
      }`}
    >
      <span aria-hidden="true">{presentation.marker} </span>
      {presentation.label}
    </span>
  );
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; rows: T[]; total: number }
  | { status: 'error'; message: string };

export type RecordTableProps<T> = {
  /** What this screen lists, for the empty state. */
  noun: string;
  emptyHint: string;
  load(): Promise<{ rows: T[]; total: number }>;
  /** Refetch when this changes — a filter, usually. */
  reloadKey?: string;
  columns: string[];
  renderRow(row: T): ReactNode;
  keyOf(row: T): string;
  /** Filter chips and the like, rendered above the table. */
  toolbar?: ReactNode;
};

export function RecordTable<T>({
  noun,
  emptyHint,
  load,
  reloadKey,
  columns,
  renderRow,
  keyOf,
  toolbar,
}: RecordTableProps<T>): ReactNode {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });

  const run = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const { rows, total } = await load();
      setState({ status: 'ready', rows, total });
    } catch (err) {
      setState({
        status: 'error',
        // The server's message, which is written for a person. A network failure
        // has none, so it gets one.
        message: err instanceof ApiError && err.message ? err.message : 'Could not reach the server.',
      });
    }
    // `load` is recreated per render by callers; `reloadKey` is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="space-y-4">
      {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}

      <div aria-live="polite">
        {state.status === 'loading' ? (
          <p className="rounded-card border border-line bg-surface p-6 text-small text-ink-muted">
            Loading {noun}…
          </p>
        ) : null}

        {state.status === 'error' ? (
          <div className="rounded-card border border-danger bg-danger-tint p-4">
            <p className="text-small font-semibold text-danger">Could not load {noun}</p>
            <p className="mt-1 text-small text-ink-muted">{state.message}</p>
            <button
              type="button"
              onClick={() => void run()}
              className="mt-3 h-control rounded-control border border-line-strong bg-surface px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Try again
            </button>
          </div>
        ) : null}

        {state.status === 'ready' && state.rows.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong bg-surface p-6">
            <p className="text-body text-ink">No {noun} yet.</p>
            <p className="mt-1 text-small text-ink-muted">{emptyHint}</p>
          </div>
        ) : null}
      </div>

      {state.status === 'ready' && state.rows.length > 0 ? (
        <>
          {/* Wide tables scroll inside their own container so the page never
              scrolls sideways on a phone. */}
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  {columns.map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 text-meta font-semibold uppercase tracking-wide text-ink-muted">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{state.rows.map((row) => <tr key={keyOf(row)} className="border-b border-line last:border-0 align-top">{renderRow(row)}</tr>)}</tbody>
            </table>
          </div>

          <p className="text-meta text-ink-muted">
            Showing {state.rows.length} of {state.total} {noun}.
          </p>
        </>
      ) : null}
    </div>
  );
}

/** A filter chip, shared by the screens that have filters. */
export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'h-control rounded-control px-3 text-small font-semibold',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        active ? 'bg-brand text-white' : 'border border-line-strong text-ink-muted',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
