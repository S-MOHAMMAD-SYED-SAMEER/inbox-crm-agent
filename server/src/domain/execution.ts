import { stableHash } from '../lib/ids.ts';
import type { ActionPlan } from './decision.ts';
import type { ActionType } from './actions.ts';

// Approval and execution vocabulary (spec §16, §15, FR-22..FR-33).
//
// THE SECURITY MODEL IN ONE LINE
//
//   AI recommends → policy decides → human approves → THE EXECUTOR VERIFIES → act
//
// The executor's verification is not a second opinion, it is the actual
// boundary. The UI can be wrong, a request body can lie, and model output is
// untrusted by construction — so the last thing before a CRM row changes
// re-derives every safety-relevant fact from the database and refuses if
// anything disagrees.

/**
 * `superseded` (M4-C) is the state an approval reaches when a human edits the
 * plan: the edit creates a new decision, so the approval on the old one is no
 * longer pending — but nobody rejected it and nothing timed out. It is terminal
 * like the other three.
 *
 * It exists as a real state rather than being inferred from
 * `decisions.superseded_by` because the expiry sweep, the queue and the
 * executor all read approval state directly. An approval left `pending` would
 * be swept, and the email would be dragged to `needs_review` while it was
 * legitimately awaiting approval on the revision.
 */
export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired', 'superseded'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const EXECUTION_STATUSES = ['pending', 'succeeded', 'failed', 'skipped'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * `sending` (M5-D) is a claim, not a status report.
 *
 * A row in `sending` belongs to one delivery attempt. Only `queued` or `failed`
 * can become it, and the transition is a conditional UPDATE the database
 * arbitrates — so of two concurrent executors exactly one proceeds and the
 * other stops before the provider is ever called (F-05).
 */
export const OUTBOX_STATUSES = ['queued', 'sending', 'sent', 'suppressed', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export type ApprovalRecord = {
  id: string;
  decisionId: string;
  state: ApprovalState;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Fingerprint of the plan as it stood when the approval was granted. */
  planHash: string | null;
  expiresAt: string;
  createdAt: string;
};

/**
 * Fingerprints the parts of a plan a person is actually authorising.
 *
 * Actions and the draft text — not the rationale or the rule trace, which are
 * explanations of the plan rather than the plan itself. Rewording a rationale
 * must not invalidate an approval; changing an action or a word of the reply
 * must.
 */
export function planFingerprint(plan: Pick<ActionPlan, 'actions' | 'draft'>): string {
  return stableHash({
    actions: plan.actions,
    draftSubject: plan.draft?.subject ?? null,
    draftBody: plan.draft?.body ?? null,
  });
}

/**
 * Why an execution was refused.
 *
 * A closed set, because each of these is a distinct safety property and the
 * tests assert on them by name. A refusal is never a generic failure: the
 * operator is told exactly which check said no.
 */
export const REFUSAL_CODES = [
  'decision_superseded',
  'approval_missing',
  'approval_not_granted',
  'approval_wrong_decision',
  'approval_expired',
  'plan_changed_since_approval',
  'unknown_action_type',
  'no_executor_for_action',
  'draft_blocked',
  'already_executed',
  'invalid_state',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type ExecutionRecord = {
  id: string;
  decisionId: string;
  sequence: number;
  actionType: ActionType;
  status: ExecutionStatus;
  targetType: string | null;
  targetId: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempt: number;
  idempotencyKey: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type OutboxRecord = {
  id: string;
  emailId: string;
  decisionId: string;
  toEmail: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  suppressedReason: string | null;
  providerMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
  /** When the current attempt claimed this row. Null unless `sending`. */
  claimedAt: string | null;
};

/**
 * The idempotency key for one action of one decision (FR-29, spec §15 step 2).
 *
 * Derived from content, not from a counter: the same action of the same
 * decision always produces the same key, so a retry collides with the UNIQUE
 * constraint instead of writing a second copy. The database enforces this, not
 * application bookkeeping — a check-then-insert has a race in it.
 */
export function idempotencyKey(decisionId: string, sequence: number, actionType: string, payload: unknown): string {
  return stableHash({ decisionId, sequence, actionType, payload });
}

export type ExecutionOutcome = {
  ok: boolean;
  /** Set when the executor refused before touching anything. */
  refusedWith: RefusalCode | null;
  refusalMessage: string | null;
  executions: ExecutionRecord[];
  outbox: OutboxRecord | null;
};
