import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { EmailSummary } from '../api/types.ts';
import { routeToHash } from '../router.ts';
import { CategoryChip, ConfidenceBadge, PriorityChip, StateChip } from '../components/understanding.tsx';
import { VerdictChip } from '../components/resolution.tsx';

// The Inbox list (M1 scope).
//
// Shows what the agent read and where each message ended up. The two actions
// are the explicit triggers from spec §14 — there is no background worker, so
// ingestion and analysis happen because somebody asked for them.
//
// Nothing here fabricates a later stage: an email that has been understood
// says "resolving", which is what it is, rather than pretending a decision
// exists.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; emails: EmailSummary[] }
  | { status: 'error'; message: string };

export function Inbox(): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { emails } = await api.listEmails();
      setState({ status: 'ready', emails });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    setBusy(label);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run('ingest', async () => {
              const result = await api.ingest();
              return `Ingested ${result.ingested} new message(s); ${result.duplicates} already known.`;
            })
          }
          className="h-control rounded-control bg-brand px-4 text-small font-semibold text-white disabled:opacity-50"
        >
          {busy === 'ingest' ? 'Ingesting…' : 'Ingest new email'}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run('understand', async () => {
              const result = await api.understandPending();
              return `Analysed ${result.processed} email(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`;
            })
          }
          className="h-control rounded-control border border-line-strong px-4 text-small font-semibold text-ink disabled:opacity-50"
        >
          {busy === 'understand' ? 'Analysing…' : 'Analyse waiting email'}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run('resolve', async () => {
              const result = await api.resolvePending();
              return `Matched ${result.resolved} email(s) against the CRM${
                result.conflicts > 0 ? `; ${result.conflicts} need a decision` : ''
              }.`;
            })
          }
          className="h-control rounded-control border border-line-strong px-4 text-small font-semibold text-ink disabled:opacity-50"
        >
          {busy === 'resolve' ? 'Matching…' : 'Match to CRM'}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run('decide', async () => {
              const result = await api.decidePending();
              return `Decided ${result.decided} email(s); ${result.awaitingApproval} waiting for approval.`;
            })
          }
          className="h-control rounded-control border border-line-strong px-4 text-small font-semibold text-ink disabled:opacity-50"
        >
          {busy === 'decide' ? 'Deciding…' : 'Decide'}
        </button>

        {notice ? <p className="text-small text-ink-muted">{notice}</p> : null}
      </div>

      {state.status === 'loading' ? <p className="text-small text-ink-muted">Loading…</p> : null}

      {state.status === 'error' ? (
        <div className="rounded-card border border-line bg-danger-tint p-4">
          <p className="text-small font-semibold text-danger">Could not load the inbox</p>
          <p className="mt-1 text-small text-ink-muted">{state.message}</p>
        </div>
      ) : null}

      {state.status === 'ready' && state.emails.length === 0 ? (
        <div className="rounded-card border border-dashed border-line-strong bg-surface p-6">
          <p className="text-body">No email yet.</p>
          <p className="mt-1 text-small text-ink-muted">
            Use “Ingest new email” to pull the demo messages in, then “Analyse waiting email”.
          </p>
        </div>
      ) : null}

      {state.status === 'ready' && state.emails.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-resting">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line text-meta uppercase tracking-wide text-ink-muted">
                <th className="px-4 py-3 font-semibold">From</th>
                <th className="px-4 py-3 font-semibold">Subject</th>
                <th className="px-4 py-3 font-semibold">Read as</th>
                <th className="px-4 py-3 font-semibold">CRM match</th>
                <th className="px-4 py-3 font-semibold">Recommendation</th>
                <th className="px-4 py-3 font-semibold">Confidence</th>
                <th className="px-4 py-3 font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {state.emails.map((email) => (
                <tr key={email.id} className="border-b border-line last:border-0 hover:bg-canvas">
                  <td className="px-4 py-3 align-top">
                    <a
                      href={routeToHash({ name: 'inbox', id: email.id })}
                      className="text-small font-semibold text-brand underline-offset-2 hover:underline"
                    >
                      {email.fromName ?? email.fromEmail}
                    </a>
                    <p className="text-meta text-ink-muted">{email.fromEmail}</p>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p className="text-small text-ink">{email.subject}</p>
                    {email.analysis ? (
                      <p className="mt-0.5 text-meta text-ink-muted">{email.analysis.summary}</p>
                    ) : (
                      <p className="mt-0.5 text-meta text-ink-muted">Not analysed yet.</p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {email.analysis ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CategoryChip category={email.analysis.category} />
                        <PriorityChip priority={email.analysis.priority} />
                        {email.analysis.injectionSuspected ? (
                          <span className="rounded-pill bg-danger-tint px-2 py-0.5 text-meta font-semibold text-danger">
                            injection suspected
                          </span>
                        ) : null}
                        {email.analysis.droppedFieldCount > 0 ? (
                          <span className="rounded-pill bg-signal-tint px-2 py-0.5 text-meta text-signal">
                            {email.analysis.droppedFieldCount} field(s) discarded
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-meta text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {email.resolution ? (
                      <div className="flex flex-col gap-1">
                        <span className="flex items-center gap-1.5 text-meta text-ink-muted">
                          contact <VerdictChip verdict={email.resolution.contact} />
                        </span>
                        <span className="flex items-center gap-1.5 text-meta text-ink-muted">
                          company <VerdictChip verdict={email.resolution.company} />
                        </span>
                      </div>
                    ) : (
                      <span className="text-meta text-ink-muted">not matched yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {email.decision ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-meta text-ink-muted">
                          {email.decision.actionCount} action{email.decision.actionCount === 1 ? '' : 's'} · tier{' '}
                          {email.decision.riskTier}
                        </span>
                        <span
                          className={`rounded-pill px-2 py-0.5 text-meta font-semibold ${
                            email.decision.requiresApproval
                              ? 'bg-signal-tint text-signal'
                              : 'bg-success-tint text-success'
                          }`}
                        >
                          {email.decision.requiresApproval ? 'needs approval' : 'can run'}
                        </span>
                        {email.decision.draftBlocked ? (
                          <span className="rounded-pill bg-danger-tint px-2 py-0.5 text-meta font-semibold text-danger">
                            draft blocked
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-meta text-ink-muted">not decided yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {email.analysis ? (
                      <ConfidenceBadge
                        band={email.analysis.confidenceBand}
                        confidence={email.analysis.confidence}
                      />
                    ) : (
                      <span className="text-meta text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <StateChip state={email.state} reviewReason={email.reviewReason} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
