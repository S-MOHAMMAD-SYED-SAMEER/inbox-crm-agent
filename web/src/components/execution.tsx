import { useState, type ReactNode } from 'react';
import type { Approval, Execution, Outbox } from '../api/types.ts';
import { presentOutbox } from '../revision/outboxPresentation.ts';
import { describeExecution } from '../revision/executionSummary.ts';

// Approval and execution presentation (stage ③).
//
// The controls here are the *only* place a person grants permission — and they
// grant it by causing a row to be written, not by revealing a button. Hiding
// the approve control would not stop an execution, and showing it does not
// authorise one: the executor re-verifies everything for itself. That is worth
// saying on the screen, because a demo audience assumes the opposite.

const ACTION_LABELS: Record<string, string> = {
  create_company: 'Create company',
  create_contact: 'Create contact',
  link_contact_to_company: 'Link contact to company',
  log_activity: 'Log activity',
  add_note: 'Add note',
  create_deal: 'Create deal',
  update_deal_stage: 'Move deal stage',
  update_deal_amount: 'Change deal value',
  create_task: 'Create task',
  archive_email: 'Archive email',
  send_email: 'Queue reply',
};

export function ExecutionCard({
  approval,
  executions,
  outbox,
  stage,
  requiresApproval,
  busy,
  refusal,
  onApprove,
  onReject,
  onExecute,
}: {
  approval: Approval | null;
  executions: Execution[];
  outbox: Outbox | null;
  stage: 'pending' | 'awaiting_approval' | 'complete' | 'failed' | 'rejected';
  requiresApproval: boolean;
  busy: boolean;
  refusal: string | null;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onExecute: () => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const succeeded = executions.filter((execution) => execution.status === 'succeeded');
  const failed = executions.filter((execution) => execution.status === 'failed');
  const showControls = stage === 'awaiting_approval' || (stage === 'pending' && !requiresApproval);

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-eyebrow uppercase text-ink-muted">3 Execute</h3>
        <span className="text-meta text-ink-muted">{stage.replace(/_/g, ' ')}</span>
      </div>

      {approval !== null ? (
        <p className="mt-2 text-small">
          <span className="text-ink-muted">Approval: </span>
          <span
            className={
              approval.state === 'approved'
                ? 'font-semibold text-success'
                : approval.state === 'rejected'
                  ? 'font-semibold text-danger'
                  : 'font-semibold text-signal'
            }
          >
            {approval.state}
          </span>
          {approval.decidedBy ? (
            <span className="text-ink-muted">
              {' '}
              by {approval.decidedBy}
              {approval.decidedAt ? ` on ${new Date(approval.decidedAt).toLocaleString()}` : ''}
            </span>
          ) : (
            <span className="text-ink-muted"> · expires {new Date(approval.expiresAt).toLocaleString()}</span>
          )}
          {approval.reason ? <span className="text-ink-muted"> — {approval.reason}</span> : null}
        </p>
      ) : null}

      {refusal !== null ? (
        <div className="mt-3 rounded-control border border-danger bg-danger-tint p-3">
          <p className="text-small font-semibold text-danger">The executor refused to run this</p>
          <p className="mt-1 text-meta text-ink-muted">{refusal}</p>
        </div>
      ) : null}

      {showControls ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {requiresApproval ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onApprove}
                className="h-control rounded-control bg-brand px-4 text-small font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Approve and run'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRejecting((open) => !open)}
                className="h-control rounded-control border border-line-strong px-4 text-small font-semibold disabled:opacity-50"
              >
                Reject
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onExecute}
              className="h-control rounded-control bg-brand px-4 text-small font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Running…' : 'Run this plan'}
            </button>
          )}
        </div>
      ) : null}

      {rejecting ? (
        <div className="mt-3 rounded-control border border-line p-3">
          <label htmlFor="reject-reason" className="text-meta uppercase text-ink-muted">
            Why are you rejecting this? (required)
          </label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-control border border-line p-2 text-small"
          />
          <button
            type="button"
            disabled={busy || reason.trim() === ''}
            onClick={() => onReject(reason.trim())}
            className="mt-2 h-control rounded-control border border-danger px-3 text-small font-semibold text-danger disabled:opacity-50"
          >
            Confirm rejection
          </button>
        </div>
      ) : null}

      {stage === 'failed' ? (
        <button
          type="button"
          disabled={busy}
          onClick={onExecute}
          className="mt-3 h-control rounded-control border border-line-strong px-4 text-small font-semibold disabled:opacity-50"
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      ) : null}

      {executions.length > 0 ? (
        <>
          <h4 className="mt-4 text-eyebrow uppercase text-ink-muted">What ran</h4>
          <ul className="mt-2 space-y-1">
            {executions.map((execution) => {
              // What was actually created, read from the stored snapshot. Falls
              // back to the record type when the snapshot cannot be named —
              // never to a guess.
              const created = describeExecution(execution);

              return (
                <li key={execution.id} className="text-small">
                  <span className={execution.status === 'succeeded' ? 'text-success' : 'text-danger'}>
                    {execution.status === 'succeeded' ? 'done' : 'failed'}
                  </span>{' '}
                  <span className="text-ink">{ACTION_LABELS[execution.actionType] ?? execution.actionType}</span>
                  {created ? (
                    <span className="text-ink"> — <span className="font-semibold">{created}</span></span>
                  ) : execution.targetType ? (
                    <span className="text-ink-muted"> — {execution.targetType}</span>
                  ) : null}
                  {execution.errorMessage ? (
                    <p className="mt-0.5 text-meta text-danger">{execution.errorMessage}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-meta text-ink-muted">
            {succeeded.length} applied{failed.length > 0 ? `, ${failed.length} failed` : ''}. Each carries a
            before and after snapshot.
          </p>
        </>
      ) : null}

      {outbox !== null ? (() => {
        // The wording comes from the server's own status. The screen never
        // decides that something was sent (M4-D §16).
        const delivery = presentOutbox(outbox);
        return (
          <div
            className={`mt-4 rounded-control border p-3 ${
              delivery.tone === 'sent'
                ? 'border-line bg-canvas'
                : delivery.tone === 'failed'
                  ? 'border-danger bg-danger-tint'
                  : 'border-signal bg-signal-tint'
            }`}
          >
            <p
              className={`text-small font-semibold ${
                delivery.tone === 'failed' ? 'text-danger' : delivery.tone === 'sent' ? 'text-ink' : 'text-signal'
              }`}
            >
              <span aria-hidden="true">{delivery.marker} </span>
              {delivery.title}
            </p>
            <p className="mt-1 text-meta text-ink-muted">{delivery.detail}</p>
            <p className="mt-2 text-meta text-ink-muted">To: {outbox.toEmail}</p>
          </div>
        );
      })() : null}

      <p className="mt-4 text-meta text-ink-muted">
        These controls are not the security boundary. The executor re-checks the approval record, the plan
        fingerprint and the policy for itself before anything is written.
      </p>
    </section>
  );
}
