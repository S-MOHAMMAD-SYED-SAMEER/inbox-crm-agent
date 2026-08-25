import { EMAIL_STATES, type EmailState } from './email.ts';

// The email state machine, written down (M5-F, audit F-08).
//
// WHY THIS FILE EXISTS
//
// The audit found thirteen states set from eight scattered `setState` calls and
// no declaration anywhere of which moves are legal. The security-relevant guard
// was — and still is — in the executor, which permits execution only from
// `awaiting_approval | deciding | execution_failed`. But "which transitions are
// legal?" was answerable only by reading every call site, and a wrong one added
// later would have been caught by nothing.
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// It is a declaration and a predicate, tested against the transitions the
// pipeline actually performs. It is NOT enforced inside `setState`, and that is
// a deliberate limitation rather than an oversight:
//
//   * the eval runners and test harnesses legitimately rewind an email to
//     `awaiting_approval` to re-exercise the executor, which is not a
//     transition the product ever performs;
//   * enforcing without an escape hatch would break them, and adding a `force`
//     flag would create exactly the bypass the table is meant to remove.
//
// So the table documents and tests the machine; the executor still enforces the
// only transition that carries authority. Turning this into an enforced guard —
// with the harnesses reworked to drive real transitions — is a worthwhile
// follow-up, and is recorded as one rather than half-done here.

/**
 * Legal moves, keyed by origin state.
 *
 * Derived from the pipeline as it is actually written: understand → resolve →
 * decide → approve → execute, with `needs_review` reachable from every stage
 * that can decline to proceed, and terminal states that nothing leaves.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<EmailState, readonly EmailState[]>> = Object.freeze({
  // Ingested and waiting for the first stage.
  received: ['understanding'],

  // UNDERSTAND either succeeds, fails outright, or declines to proceed.
  understanding: ['resolving', 'understand_failed', 'needs_review'],
  understand_failed: ['understanding'], // retryable

  // Entity resolution. A conflict routes to a human rather than guessing.
  resolving: ['deciding', 'needs_review'],

  // DECIDE produces a plan, or produces none and asks for a person.
  deciding: ['awaiting_approval', 'needs_review', 'executing', 'completed', 'archived'],

  // The approval queue. Expiry moves to needs_review and never to execution:
  // a timeout must not resolve in the direction of acting (§16).
  awaiting_approval: ['executing', 'rejected', 'needs_review', 'expired'],

  // A human looks at it. From here it goes back into the pipeline or stops.
  needs_review: ['understanding', 'resolving', 'deciding', 'awaiting_approval', 'archived', 'rejected'],

  // EXECUTE is in flight.
  executing: ['completed', 'archived', 'execution_failed'],

  // Retryable: the retry path exists precisely for this.
  execution_failed: ['executing', 'needs_review'],

  // Terminal.
  completed: [],
  rejected: [],
  expired: ['needs_review'], // a person can pick an expired item back up
  archived: [],
});

/** States nothing leaves. */
export const TERMINAL_EMAIL_STATES: readonly EmailState[] = EMAIL_STATES.filter(
  (state) => LEGAL_TRANSITIONS[state].length === 0,
);

export function isLegalTransition(from: EmailState, to: EmailState): boolean {
  // A no-op move is always legal: re-asserting the current state changes
  // nothing, and callers that set a state idempotently are not doing anything
  // the machine needs to object to.
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Every legal move, as pairs. For documentation and exhaustive testing. */
export function allLegalTransitions(): Array<{ from: EmailState; to: EmailState }> {
  return EMAIL_STATES.flatMap((from) => LEGAL_TRANSITIONS[from].map((to) => ({ from, to })));
}
