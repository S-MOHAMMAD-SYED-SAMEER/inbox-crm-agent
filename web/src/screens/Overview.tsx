import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import { MilestonePlaceholder } from '../components/MilestonePlaceholder.tsx';
import { connectionStatus, systemFacts, type StatusFact } from '../system/statusPresentation.ts';
import type { Health } from '../api/types.ts';

// Overview — the first screen after signing in.
//
// It reports live system status from `GET /api/health`, which makes it the
// end-to-end proof that everything is wired together: browser → Express →
// handler → repository → migrated schema, with a real answer coming back.
//
// WHAT CHANGED IN M6-E, AND WHY
//
// This screen used to be a diagnostics panel. It printed the health `adapters`
// object as raw key/value pairs and carried a dashed panel headed "Arrives in
// M5" — a milestone that had shipped, as authentication and outbound safety,
// without bringing this screen with it. So the first thing anyone saw after
// signing in was a build number and a promise that had quietly become false.
//
// The dashed panel is now the same `MilestonePlaceholder` the two remaining
// unbuilt screens use. That component was cleaned of milestone language in
// M6-B; this screen was missed, and reusing it means there is now exactly one
// place that says "not built yet" and one way of saying it.
//
// The status facts themselves are unchanged — same endpoint, same values. They
// are rendered through `system/statusPresentation.ts`, which states them in
// sentences rather than key/value pairs. Nothing was hidden to make the system
// look more finished than it is: demo mode still says demo mode.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; health: Health }
  | { status: 'error'; message: string };

export function Overview(): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((health) => {
        if (!cancelled) setState({ status: 'ready', health });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The client turns every failure — including a network drop, which has
        // no envelope — into one ApiError, so there is exactly one error shape
        // to render here.
        const message = err instanceof ApiError ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-6 shadow-resting">
        <h2 className="text-subhead">System status</h2>

        {state.status === 'loading' ? (
          <p className="mt-3 text-small text-ink-muted">Checking…</p>
        ) : null}

        {state.status === 'error' ? (
          <div className="mt-3 rounded-control border border-line bg-danger-tint p-4">
            <p className="text-small font-semibold text-danger">Not connected</p>
            <p className="mt-1 text-small text-ink-muted">{state.message}</p>
            <p className="mt-2 text-meta text-ink-muted">
              Start the API with <code className="font-mono">npm run dev</code> in{' '}
              <code className="font-mono">inbox-crm-agent/server</code>.
            </p>
          </div>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <dl className="mt-4">
              <Fact fact={connectionStatus(state.health)} prominent />
            </dl>

            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              {systemFacts(state.health).map((fact) => (
                <Fact key={fact.label} fact={fact} />
              ))}
            </dl>

            <p className="mt-4 text-meta text-ink-muted">
              Configuration is reported as configured or not — never the values themselves. No key, no fragment of a
              key, and no connection string reaches the browser.
            </p>
          </>
        ) : null}
      </section>

      <MilestonePlaceholder
        summary="A single view answering “is the inbox under control?” — how much is waiting, how long it has waited, and what the assistant handled without anyone."
        availableToday="Everything it will summarise can be seen now: the Inbox lists every message and where it ended up, Approvals lists what is waiting for a person, and the audit log records every decision."
        willShow={[
          'How many messages need a person, and how long the oldest has waited',
          'How many the assistant handled on its own, and the share that is',
          'Open pipeline value from the deals it opened',
        ]}
      />
    </div>
  );
}

function Fact({ fact, prominent = false }: { fact: StatusFact; prominent?: boolean }): ReactNode {
  // Tone is carried by the text as well as the colour: status is never
  // communicated by colour alone (NFR-11). Every fact states its value in
  // words, and the detail line says what that value means.
  const toneClass = fact.tone === 'good' ? 'text-success' : fact.tone === 'bad' ? 'text-danger' : 'text-ink';

  return (
    <div className="rounded-control border border-line p-3">
      <dt className="text-meta uppercase tracking-wide text-ink-muted">{fact.label}</dt>
      <dd className={`mt-1 ${prominent ? 'text-subhead' : 'text-body'} ${toneClass}`}>{fact.value}</dd>
      <dd className="mt-1 text-meta text-ink-muted">{fact.detail}</dd>
    </div>
  );
}
