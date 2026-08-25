import type { Repositories } from '../../db/repositories/index.ts';
import type { ApprovalRecord } from '../../domain/execution.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';

// The approval expiry sweep (spec §16).
//
// THE RULE, VERBATIM: "Expiry does not execute and does not discard — it moves
// the email to `needs_review` with reason `approval_expired`. Timeouts must
// never resolve in the direction of acting."
//
// That is the whole design. An approval that nobody answered is not a tacit
// yes and not a silent no: it is a question that went unanswered, which is
// exactly the thing a person should be told about. So the sweep moves work
// *towards* a human and never towards an action.
//
// IDEMPOTENT BY CONSTRUCTION. It selects only `pending` rows past their expiry
// and transitions them out of `pending`, so a second run finds nothing and
// writes nothing — including no second audit event. There is no bookkeeping
// flag to get wrong; the state itself is the guard.
//
// NOT A BACKGROUND WORKER. It is a function, called explicitly by
// `POST /api/approvals/expire` — the same "triggering is explicit" rule the
// rest of the pipeline follows (§14). A scheduler can call it later without
// this code changing.

export type ExpirySweepResult = {
  expired: Array<{ approvalId: string; decisionId: string; emailId: string; subject: string }>;
  /** Approvals that were past due but whose email had already moved on. */
  skipped: number;
};

export type ExpirySweepDeps = {
  repos: Repositories;
  clock?: Clock;
  logger?: Logger;
  /** Safety cap so one sweep cannot run unboundedly. */
  limit?: number;
};

export async function sweepExpiredApprovals({
  repos,
  clock = systemClock,
  logger = createLogger('expiry'),
  limit = 100,
}: ExpirySweepDeps): Promise<ExpirySweepResult> {
  const now = clock.nowIso();
  const overdue = await repos.approvals.listExpired(now, limit);

  const expired: ExpirySweepResult['expired'] = [];
  let skipped = 0;

  for (const approval of overdue) {
    const decision = await repos.decisions.getById(approval.decisionId);
    if (!decision) {
      skipped++;
      continue;
    }

    const email = await repos.emails.getById(decision.emailId);
    if (!email) {
      skipped++;
      continue;
    }

    // If the email is no longer waiting on this approval, something else has
    // already moved it on. Dragging it back to review would undo whatever that
    // was — so the approval is left alone and reported as skipped rather than
    // quietly rewritten.
    if (email.state !== 'awaiting_approval') {
      skipped++;
      logger.warn('Skipping an overdue approval whose email has moved on', {
        emailId: email.id,
        state: email.state,
      });
      continue;
    }

    await repos.approvals.decide(approval.decisionId, 'expired', {
      decidedBy: 'system',
      reason: 'No one answered before the approval window closed.',
    });

    // Towards the human, never towards the action.
    await repos.emails.setState(email.id, 'needs_review', {
      expectedFrom: 'awaiting_approval',
      reviewReason: 'approval_expired',
    });

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'approval',
      eventType: 'approval_expired',
      actor: 'system',
      outcome: 'blocked',
      summary:
        'The approval window closed with no decision. Nothing was run, and this is now waiting for a person.',
      payload: {
        decisionId: decision.id,
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
        riskTier: decision.plan.riskTier,
      },
      entityType: 'decision',
      entityId: decision.id,
    });

    expired.push({
      approvalId: approval.id,
      decisionId: decision.id,
      emailId: email.id,
      subject: email.subject,
    });
  }

  if (expired.length > 0 || skipped > 0) {
    logger.info('Expiry sweep complete', { expired: expired.length, skipped });
  }

  return { expired, skipped };
}

/**
 * Whether an approval is past its window, independent of whether the sweep has
 * run yet.
 *
 * The queue uses this so a pending row that is already overdue is never shown
 * as actionable work. The executor makes the same comparison for itself
 * (M4-A), so an unswept overdue approval cannot execute either way — this is
 * about telling the truth on screen, not about safety.
 */
export function isOverdue(approval: Pick<ApprovalRecord, 'state' | 'expiresAt'>, now: string): boolean {
  if (approval.state === 'expired') return true;
  return approval.state === 'pending' && approval.expiresAt <= now;
}
