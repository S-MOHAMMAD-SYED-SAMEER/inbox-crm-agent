import type { Approval, ApprovalState, DecisionRevision } from '../api/types.ts';

// How the five approval states are presented, in one place.
//
// WHY THIS IS A MODULE AND NOT JSX
//
// Two reasons. Every screen that shows an approval — the queue, the email
// detail, the revision history — has to agree about what "superseded" means and
// whether it can be acted on, and three components each deciding for themselves
// is how they drift. And this is the logic worth testing, which the project
// tests with `node --test` on plain modules rather than by rendering (NFR-9).
//
// ACTIONABILITY IS NOT A STYLING CONCERN. `actionable` below is what decides
// whether approve/reject controls exist at all. It is still only advice: the
// server re-verifies every approval for itself, and the UI has never been the
// security boundary.

export type ApprovalTone = 'waiting' | 'done' | 'stopped' | 'replaced';

export type ApprovalPresentation = {
  state: ApprovalState;
  /** Short label for a chip or a filter. */
  label: string;
  /** A sentence a non-technical operator can read. */
  description: string;
  tone: ApprovalTone;
  /**
   * A shape/word cue that carries the meaning without colour, so the state is
   * legible to someone who cannot distinguish the tones (§15).
   */
  marker: string;
  /** Whether a person can still approve or reject this. */
  actionable: boolean;
};

const PRESENTATION: Readonly<Record<ApprovalState, Omit<ApprovalPresentation, 'state'>>> = Object.freeze({
  pending: {
    label: 'Waiting for you',
    description: 'This is ready for a person to approve or reject.',
    tone: 'waiting',
    marker: '●',
    actionable: true,
  },
  approved: {
    label: 'Approved',
    description: 'A person approved this and it was carried out.',
    tone: 'done',
    marker: '✓',
    actionable: false,
  },
  rejected: {
    label: 'Rejected',
    description: 'A person rejected this, so nothing was carried out.',
    tone: 'stopped',
    marker: '✕',
    actionable: false,
  },
  expired: {
    label: 'Expired',
    description: 'Nobody got to this in time, so it went back for a fresh look. Nothing was carried out.',
    tone: 'stopped',
    marker: '⏱',
    actionable: false,
  },
  superseded: {
    label: 'Replaced',
    description: 'This revision was replaced by a newer decision.',
    tone: 'replaced',
    marker: '↳',
    actionable: false,
  },
});

export const APPROVAL_STATES: readonly ApprovalState[] = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
];

export function presentApproval(state: ApprovalState): ApprovalPresentation {
  return { state, ...PRESENTATION[state] };
}

/**
 * Whether a person may act on this approval right now.
 *
 * An overdue approval is not actionable even while its state still says
 * pending: the sweep may not have run yet, but the executor would refuse it
 * either way (M4-B), and offering a button that cannot work is worse than
 * offering none.
 */
export function isActionable(approval: Pick<Approval, 'state'>, overdue = false): boolean {
  return presentApproval(approval.state).actionable && !overdue;
}

/**
 * What to tell the reviewer after a revision is created.
 *
 * A function rather than a string in JSX, because the thing it must never say
 * is testable: creating a revision approves nothing, runs nothing and sends
 * nothing, and the wording has to keep saying so even after somebody edits it.
 */
export function revisionSuccessMessage(revision: number): string {
  return (
    `Revision ${revision} created and submitted for approval. ` +
    'The earlier version was replaced, and nothing has been carried out yet.'
  );
}

export type RevisionHistoryRow = {
  id: string;
  revision: number;
  /** "AI-generated" or "Human edit by <name>". */
  authorLabel: string;
  /** "Original decision" when nothing came before it. */
  lineageLabel: string;
  stateLabel: string;
  stateMarker: string;
  tone: ApprovalTone | 'none';
  isCurrent: boolean;
  isHumanEdit: boolean;
};

/**
 * Turns the API's revision list into rows a person can read.
 *
 * Nothing here is inferred: the origin, the editor, the parent and the approval
 * state all come from the server. A history the frontend guessed at would be
 * worse than no history, because it would look equally authoritative.
 */
export function buildRevisionHistory(revisions: readonly DecisionRevision[]): RevisionHistoryRow[] {
  return revisions.map((entry) => {
    const presentation = entry.approvalState === null ? null : presentApproval(entry.approvalState);

    return {
      id: entry.id,
      revision: entry.revision,
      authorLabel:
        entry.origin === 'human_edit'
          ? `Human edit by ${entry.editedBy ?? 'someone'}`
          : 'AI-generated',
      lineageLabel: entry.parentDecisionId === null ? 'Original decision' : `Revised from revision ${entry.revision - 1}`,
      stateLabel: presentation?.label ?? 'No approval needed',
      stateMarker: presentation?.marker ?? '–',
      tone: presentation?.tone ?? 'none',
      isCurrent: entry.isCurrent,
      isHumanEdit: entry.origin === 'human_edit',
    };
  });
}

/**
 * Whether the plan on screen can be edited.
 *
 * Derived from facts the detail response already carries, and mirroring the
 * server's rule (M4-C.2 `assertEditable`) so the UI does not offer an action
 * that would certainly be refused. It is NOT the decision — `POST /revise`
 * re-checks all of this against the database, and that check is the real one.
 */
export function canEdit(detail: {
  approval: Pick<Approval, 'state'> | null;
  decision: { supersededBy: string | null } | null;
  executions: readonly unknown[];
  email: { state: string };
}): { editable: boolean; reason: string | null } {
  if (detail.decision === null) return { editable: false, reason: 'There is no proposal to edit yet.' };
  if (detail.decision.supersededBy !== null) {
    return { editable: false, reason: 'This plan was replaced by a newer one.' };
  }
  if (detail.email.state === 'executing') {
    return { editable: false, reason: 'This plan is being carried out right now.' };
  }
  if (detail.executions.length > 0) {
    return { editable: false, reason: 'This plan has already started making changes, so it can no longer be edited.' };
  }
  if (detail.approval === null) return { editable: false, reason: 'This plan is not waiting for approval.' };
  if (detail.approval.state !== 'pending') {
    return { editable: false, reason: `This plan was already ${presentApproval(detail.approval.state).label.toLowerCase()}.` };
  }
  return { editable: true, reason: null };
}
