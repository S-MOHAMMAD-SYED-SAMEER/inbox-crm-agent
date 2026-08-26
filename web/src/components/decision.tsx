import { useState, type ReactNode } from 'react';
import type { Decision } from '../api/types.ts';

// Decision presentation (stage ②).
//
// Two things this screen must get across, because they are the product:
//
//   1. The recommendation is explainable. Not "the AI decided" — the actions,
//      the rules that produced them, and the sentence a non-technical operator
//      can read.
//   2. Approval is not a formality. When approval is required the screen says
//      which specific action triggered it, never "this is risky".
//
// The approve/reject controls live on the approvals queue and the email detail
// screen, not here: this component renders what was proposed, and it renders it
// identically whether or not the plan has since run.
//
// M6-E: the closing line used to read "Approving and running a plan arrives in
// M4. Nothing has been written to the CRM and nothing has been sent." Execution
// shipped in M4-A, which made the first sentence stale and the second one
// FALSE — an executed plan has written to the CRM, and this card sat directly
// above the execution results saying otherwise. It now states the rule, which
// is true in every state, rather than a claim about what has happened.

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
  send_email: 'Send reply',
};

// Exported so the approvals queue shows the same words. A client should never
// have to learn what "tier 2" means to use this screen; the label says it.
export const TIER_LABELS: Record<number, string> = {
  0: 'Safe — append-only',
  1: 'Creates a record',
  2: 'Consequential',
};

function actionSummary(action: { type: string; payload: unknown }): string | null {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  if (action.type === 'create_deal') {
    return `${String(payload.title ?? '')} · stage ${String(payload.stage ?? '')}`;
  }
  if (action.type === 'update_deal_stage') {
    return `${String(payload.fromStage ?? '')} → ${String(payload.toStage ?? '')}`;
  }
  if (action.type === 'create_task' || action.type === 'create_company') {
    return String(payload.title ?? payload.name ?? '') || null;
  }
  if (action.type === 'create_contact') {
    return `${String(payload.fullName ?? '')} <${String(payload.email ?? '')}>`;
  }
  if (action.type === 'send_email') return `to ${String(payload.toEmail ?? '')}`;
  return null;
}

export function DecisionCard({ decision }: { decision: Decision }): ReactNode {
  const [showTrace, setShowTrace] = useState(false);
  const plan = decision.plan;
  const blocked = (plan.draft?.blockedBy.length ?? 0) > 0;

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-eyebrow uppercase text-ink-muted">② Decide</h3>
        <span className="text-meta text-ink-muted" title={`Risk tier ${plan.riskTier}`}>
          {plan.actions.length} action{plan.actions.length === 1 ? '' : 's'} · {TIER_LABELS[plan.riskTier]}
        </span>
      </div>

      {plan.actions.length === 0 ? (
        <p className="mt-3 text-small text-ink-muted">
          No action was recommended. {plan.rationale}
        </p>
      ) : (
        <>
          <h4 className="mt-3 text-eyebrow uppercase text-ink-muted">Recommended</h4>
          <ul className="mt-2 space-y-1">
            {plan.actions.map((action, index) => (
              <li key={`${action.type}-${index}`} className="text-small">
                <span className="text-ink">• {ACTION_LABELS[action.type] ?? action.type}</span>
                {actionSummary(action) ? (
                  <span className="text-ink-muted"> — {actionSummary(action)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="mt-4 text-eyebrow uppercase text-ink-muted">Why</h4>
      <p className="mt-1 text-small text-ink-muted">{plan.rationale}</p>

      <button
        type="button"
        onClick={() => setShowTrace((open) => !open)}
        className="mt-2 text-meta text-brand underline-offset-2 hover:underline"
      >
        {showTrace ? 'Hide' : 'Show'} the rule trace ({plan.ruleTrace.length} rules)
      </button>

      {showTrace ? (
        <ul className="mt-2 space-y-1 rounded-control border border-line p-3">
          {plan.ruleTrace.map((entry) => (
            <li key={entry.rule} className="text-meta">
              <span className={entry.fired ? 'font-semibold text-brand' : 'text-ink-muted'}>
                {entry.rule} {entry.fired ? 'fired' : 'did not fire'}
              </span>
              <span className="text-ink-muted"> — {entry.because}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Approval state. Named triggers, never "this is risky". */}
      <div
        className={`mt-4 rounded-control border p-3 ${
          plan.requiresApproval ? 'border-signal bg-signal-tint' : 'border-success bg-success-tint'
        }`}
      >
        <p className={`text-small font-semibold ${plan.requiresApproval ? 'text-signal' : 'text-success'}`}>
          {plan.requiresApproval ? 'Approval required' : 'Can run without approval'}
        </p>
        {plan.approvalReasons.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {plan.approvalReasons.map((reason) => (
              <li key={reason.code} className="text-meta text-ink-muted">
                {reason.message}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-meta text-ink-muted">
          A plan is a proposal. Nothing reaches the CRM or a customer until it is run, and a plan that needs
          approval cannot run until a person approves it.
        </p>
      </div>

      {/* Draft */}
      {plan.draft !== null ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-eyebrow uppercase text-ink-muted">Drafted reply</h4>
            <span className={`text-meta font-semibold ${blocked ? 'text-danger' : 'text-success'}`}>
              {blocked
                ? `blocked by ${plan.draft.blockedBy.length} check(s)`
                : `passed all ${plan.draft.guardrailsPassed.length} checks`}
            </span>
          </div>

          {blocked ? (
            <div className="mt-2 rounded-control border border-danger bg-danger-tint p-3">
              <p className="text-small font-semibold text-danger">
                This text was stopped before anyone could send it
              </p>
              <ul className="mt-2 space-y-1">
                {plan.draft.blockedBy.map((violation) => (
                  <li key={violation.guardrail} className="text-meta">
                    <span className="font-mono font-semibold text-danger">{violation.guardrail}</span>
                    <span className="text-ink-muted"> — {violation.why}</span>
                    <p className="mt-0.5 rounded border border-line bg-surface p-1.5 font-mono text-ink">
                      {violation.evidence}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-2 rounded-control border border-line p-3">
            <p className="text-meta text-ink-muted">Subject</p>
            <p className="text-small text-ink">{plan.draft.subject}</p>
            <p className="mt-2 text-meta text-ink-muted">Body</p>
            <pre className="whitespace-pre-wrap font-sans text-small leading-relaxed text-ink">
              {plan.draft.body}
            </pre>
          </div>
        </div>
      ) : plan.draftFailedReason !== null ? (
        <div className="mt-4 rounded-control border border-signal bg-signal-tint p-3">
          <p className="text-small font-semibold text-signal">No reply was drafted</p>
          <p className="mt-1 text-meta text-ink-muted">
            {plan.draftFailedReason} The plan itself is unaffected — a person writes this reply.
          </p>
        </div>
      ) : (
        <p className="mt-4 text-meta text-ink-muted">
          No reply is drafted for this kind of email.
        </p>
      )}
    </section>
  );
}
