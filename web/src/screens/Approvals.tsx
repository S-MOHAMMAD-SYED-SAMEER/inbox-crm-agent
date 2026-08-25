import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { ApprovalQueueRow, ApprovalState, EmailDetail, RevisionResult } from '../api/types.ts';
import { routeToHash } from '../router.ts';
import { PlanDiff } from '../components/planDiff.tsx';
import { RevisionHistory } from '../components/revisionHistory.tsx';
import { ReviseForm } from '../components/reviseForm.tsx';
import {
  APPROVAL_STATES,
  canEdit,
  presentApproval,
  revisionSuccessMessage,
} from '../revision/approvalPresentation.ts';

// The approval queue (spec §13.4, extended by M4-C.3).
//
// The operator's highest-frequency task, so the collapsed row carries exactly
// what a ten-second decision needs — who it is from, what is recommended, the
// risk tier, the confidence, and how long is left. Expanding it shows what will
// happen if approved, and now offers the third answer: not "yes" or "no" but
// "nearly — change this first".
//
// A revision is not an approval. Editing produces a new proposal that is still
// waiting for a person, and every label on this screen is written so nobody
// could read it otherwise.
//
// ONE DELIBERATE ABSENCE: no bulk approve. §13.4 rules it out for tier 2, and
// the whole value proposition is that a person looked at the email that gets
// sent.

const TONE_CLASS: Record<string, string> = {
  waiting: 'bg-signal-tint text-signal',
  done: 'bg-canvas text-ink-muted',
  stopped: 'bg-danger-tint text-danger',
  replaced: 'bg-canvas text-ink-muted',
};

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: ApprovalQueueRow[]; counts: Record<string, number> }
  | { status: 'error'; message: string };

export function Approvals(): ReactNode {
  const [filter, setFilter] = useState<ApprovalState>('pending');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api.listApprovals(filter);
      setState({ status: 'ready', rows: result.approvals, counts: result.counts });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Expanding a row loads the full detail: the history and editability live there. */
  const open = async (row: ApprovalQueueRow): Promise<void> => {
    if (expanded === row.approval.id) {
      setExpanded(null);
      setEditing(null);
      setDetail(null);
      return;
    }
    setExpanded(row.approval.id);
    setEditing(null);
    setDetail(null);
    try {
      setDetail(await api.getEmail(row.email.id));
    } catch {
      setDetail(null);
    }
  };

  const run = async (key: string, action: () => Promise<string>): Promise<void> => {
    setBusy(key);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
      setRejecting(null);
      setReason('');
    }
  };

  const onRevised = async (result: RevisionResult): Promise<void> => {
    // Nothing is assumed: the returned detail is the server's own account of
    // where things now stand, and the queue is reloaded from it.
    setEditing(null);
    setDetail(result.detail);
    setExpanded(result.approval.id);
    setNotice(revisionSuccessMessage(result.revision));
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {APPROVAL_STATES.map((value) => {
          const presentation = presentApproval(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={[
                'h-control rounded-control px-3 text-small font-semibold',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                filter === value ? 'bg-brand text-white' : 'border border-line-strong text-ink-muted',
              ].join(' ')}
            >
              {presentation.label}
              {state.status === 'ready' && state.counts[value] !== undefined ? (
                <span className="ml-1.5 opacity-75">{state.counts[value]}</span>
              ) : null}
            </button>
          );
        })}

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run('expire', async () => {
              const result = await api.expireApprovals();
              return result.expired === 0
                ? 'Nothing had passed its approval window.'
                : `${result.expired} approval(s) expired and went to human review.`;
            })
          }
          className="ml-auto h-control rounded-control border border-line-strong px-3 text-small font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {busy === 'expire' ? 'Sweeping…' : 'Run expiry sweep'}
        </button>
      </div>

      <div aria-live="polite">
        {notice ? (
          <p className="rounded-control border border-line bg-surface p-3 text-small text-ink">{notice}</p>
        ) : null}
      </div>

      {state.status === 'loading' ? <p className="text-small text-ink-muted">Loading…</p> : null}

      {state.status === 'error' ? (
        <div className="rounded-card border border-line bg-danger-tint p-4">
          <p className="text-small font-semibold text-danger">Could not load the queue</p>
          <p className="mt-1 text-small text-ink-muted">{state.message}</p>
        </div>
      ) : null}

      {state.status === 'ready' && state.rows.length === 0 ? (
        <div className="rounded-card border border-dashed border-line-strong bg-surface p-6">
          <p className="text-body">Nothing here.</p>
          {filter === 'pending' ? (
            <p className="mt-1 text-small text-ink-muted">
              An empty approval queue is a good state, not a missing feature.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.status === 'ready'
        ? state.rows.map((row) => {
            const isOpen = expanded === row.approval.id;
            const presentation = presentApproval(row.approval.state);
            const slaLabel =
              row.msToExpiry < 0
                ? `${formatDuration(row.msToExpiry)} overdue`
                : `${formatDuration(row.msToExpiry)} left`;

            const rowDetail = isOpen && detail?.email.id === row.email.id ? detail : null;
            const editable = rowDetail ? canEdit(rowDetail) : { editable: false, reason: null };
            const currentDecision = rowDetail?.decision ?? row.decision;

            return (
              <section
                key={row.approval.id}
                className={`rounded-card border bg-surface shadow-resting ${
                  row.overdue && row.approval.state === 'pending' ? 'border-danger' : 'border-line'
                }`}
              >
                <div className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <a
                        href={routeToHash({ name: 'inbox', id: row.email.id })}
                        className="text-small font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      >
                        {row.email.fromName ?? row.email.fromEmail}
                      </a>
                      <span className="text-small text-ink"> — {row.email.subject}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-pill border border-line-strong px-2 py-0.5 text-meta text-ink-muted">
                        tier {row.riskTier}
                      </span>
                      {row.confidenceBand !== null ? (
                        <span className="rounded-pill border border-line-strong px-2 py-0.5 text-meta text-ink-muted">
                          {row.confidenceBand} confidence {row.confidence?.toFixed(2)}
                        </span>
                      ) : null}
                      {currentDecision.origin === 'human_edit' ? (
                        <span className="rounded-pill border border-line-strong px-2 py-0.5 text-meta text-ink-muted">
                          revision {currentDecision.revision} · edited by {currentDecision.editedBy ?? 'a person'}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-pill px-2 py-0.5 text-meta font-semibold ${
                          row.approval.state === 'pending'
                            ? row.overdue
                              ? TONE_CLASS.stopped
                              : TONE_CLASS.waiting
                            : (TONE_CLASS[presentation.tone] ?? TONE_CLASS.done)
                        }`}
                      >
                        <span aria-hidden="true">{presentation.marker} </span>
                        {row.approval.state === 'pending' ? slaLabel : presentation.label}
                      </span>
                    </div>
                  </div>

                  <p className="mt-2 text-meta text-ink-muted">{row.recommendation}</p>

                  {row.approval.state !== 'pending' ? (
                    <p className="mt-1 text-meta text-ink-muted">
                      {presentation.description}
                      {row.approval.decidedBy && row.approval.state !== 'superseded'
                        ? ` (${row.approval.decidedBy})`
                        : ''}
                      {row.approval.reason ? ` — ${row.approval.reason}` : ''}
                    </p>
                  ) : null}

                  {row.draftBlocked ? (
                    <p className="mt-2 rounded-control bg-danger-tint px-2 py-1 text-meta font-semibold text-danger">
                      The drafted reply was stopped by a content check and must be rewritten before it can be sent.
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void open(row)}
                      aria-expanded={isOpen}
                      className="text-meta text-brand underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    >
                      {isOpen ? 'Hide' : 'Show'} what will happen ({row.decision.plan.actions.length} actions)
                    </button>

                    {row.actionable ? (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(row.approval.id, async () => {
                              const result = await api.approve(row.decision.id);
                              return result.ok
                                ? `Approved and carried out ${result.executed} action(s).`
                                : `Refused: ${result.refusalMessage ?? result.refusedWith}`;
                            })
                          }
                          className="h-control rounded-control bg-brand px-3 text-meta font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
                        >
                          {busy === row.approval.id ? 'Working…' : 'Approve and run'}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => setRejecting(rejecting === row.approval.id ? null : row.approval.id)}
                          className="h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
                        >
                          Reject
                        </button>

                        {isOpen && editable.editable ? (
                          <button
                            type="button"
                            onClick={() => setEditing(editing === row.approval.id ? null : row.approval.id)}
                            aria-expanded={editing === row.approval.id}
                            className="h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                          >
                            {editing === row.approval.id ? 'Stop editing' : 'Edit proposal'}
                          </button>
                        ) : null}
                      </>
                    ) : row.approval.state === 'pending' ? (
                      <span className="text-meta text-danger">
                        Past its window — run the sweep; this needs a fresh look, not an approval.
                      </span>
                    ) : (
                      <span className="text-meta text-ink-muted">{presentation.description}</span>
                    )}
                  </div>

                  {rejecting === row.approval.id ? (
                    <div className="mt-3 rounded-control border border-line p-3">
                      <label htmlFor={`reason-${row.approval.id}`} className="text-meta uppercase text-ink-muted">
                        Why are you rejecting this? (required)
                      </label>
                      <textarea
                        id={`reason-${row.approval.id}`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        rows={2}
                        className="mt-1 w-full rounded-control border border-line p-2 text-small focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      />
                      <button
                        type="button"
                        disabled={busy !== null || reason.trim() === ''}
                        onClick={() =>
                          void run(row.approval.id, async () => {
                            await api.reject(row.decision.id, reason.trim());
                            return 'Rejected. Nothing was carried out.';
                          })
                        }
                        className="mt-2 h-control rounded-control border border-danger px-3 text-meta font-semibold text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
                      >
                        Confirm rejection
                      </button>
                    </div>
                  ) : null}
                </div>

                {isOpen ? (
                  <div className="space-y-4 border-t border-line bg-canvas p-4">
                    {editing === row.approval.id && rowDetail?.decision ? (
                      <ReviseForm
                        decisionId={rowDetail.decision.id}
                        plan={rowDetail.decision.plan}
                        onCancel={() => setEditing(null)}
                        onRevised={(result) => void onRevised(result)}
                      />
                    ) : (
                      <>
                        <div>
                          <h4 className="text-eyebrow uppercase tracking-wide text-ink-muted">
                            What will happen if approved
                          </h4>
                          <p className="mt-1 text-meta text-ink-muted">
                            {currentDecision.origin === 'human_edit'
                              ? `Prepared by the assistant, then edited by ${currentDecision.editedBy ?? 'a person'}. Still waiting for approval.`
                              : 'Prepared by the assistant. Nothing happens until a person approves it.'}
                          </p>
                          <div className="mt-2">
                            <PlanDiff actions={currentDecision.plan.actions} />
                          </div>
                        </div>

                        {currentDecision.plan.approvalReasons.length > 0 ? (
                          <div>
                            <h4 className="text-eyebrow uppercase tracking-wide text-ink-muted">Why this needs you</h4>
                            <ul className="mt-1 space-y-0.5">
                              {currentDecision.plan.approvalReasons.map((entry) => (
                                <li key={entry.code} className="text-meta text-ink-muted">
                                  {entry.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {currentDecision.plan.draft !== null ? (
                          <div>
                            <h4 className="text-eyebrow uppercase tracking-wide text-ink-muted">
                              The reply that would be queued
                            </h4>
                            <div className="mt-1 rounded-control border border-line bg-surface p-3">
                              <p className="text-small font-semibold text-ink">{currentDecision.plan.draft.subject}</p>
                              <p className="mt-1 whitespace-pre-wrap break-words text-small leading-relaxed text-ink">
                                {currentDecision.plan.draft.body}
                              </p>
                            </div>
                            <p className="mt-1 text-meta text-ink-muted">
                              Nothing is delivered until a person approves it, and only then if
                              outbound sending has been turned on in the server configuration.
                            </p>
                          </div>
                        ) : null}

                        {rowDetail ? <RevisionHistory revisions={rowDetail.revisions} /> : null}

                        {rowDetail && !editable.editable && editable.reason ? (
                          <p className="text-meta text-ink-muted">{editable.reason}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })
        : null}
    </div>
  );
}
