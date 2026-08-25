// How an email's workflow state is described (M6-E).
//
// Pure, so it can be tested without a browser (NFR-9) — the same split the
// revision, outbox, CRM and status presentation modules use.
//
// WHY THIS EXISTS
//
// The state chip used to render `state.replace(/_/g, ' ')`: the database enum
// with its underscores stripped. The Inbox — the busiest screen in the demo —
// therefore spoke in state-machine names ("Deciding", "Understand failed")
// while the CRM screens next door had proper plain-language maps. One product
// spoke two languages depending which tab you were on.
//
// These labels say what is *happening to the email*, and specifically who is
// expected to act next, which is the only question a person actually has when
// looking at a list of them. They are not a rename of the states: `EMAIL_STATES`
// is unchanged and remains the vocabulary of the API, the audit trail and the
// tests. This is presentation, and nothing reads it back.
//
// TONE
//
// Tone was previously wrong in both directions: `resolving` — a transient
// mid-pipeline state — rendered green, while `execution_failed`, `rejected` and
// `expired` rendered the same neutral grey as an idle state, so a failure
// looked like nothing had happened. Tone now follows one rule: green means
// finished and fine, red means something went wrong, amber means a person is
// needed, grey means in flight. Every chip also states its label in words, so
// nothing is signalled by colour alone (NFR-11).

export type StateTone = 'done' | 'failed' | 'attention' | 'working';

export type StatePresentation = {
  label: string;
  tone: StateTone;
  /** A non-colour cue, so tone survives without colour (NFR-11). */
  marker: string;
};

const STATES: Readonly<Record<string, StatePresentation>> = Object.freeze({
  received: { label: 'Received', tone: 'working', marker: '·' },
  understanding: { label: 'Reading', tone: 'working', marker: '·' },
  understand_failed: { label: 'Could not read', tone: 'failed', marker: '!' },
  resolving: { label: 'Matching records', tone: 'working', marker: '·' },
  deciding: { label: 'Planning', tone: 'working', marker: '·' },
  awaiting_approval: { label: 'Waiting for approval', tone: 'attention', marker: '◷' },
  needs_review: { label: 'Needs a person', tone: 'attention', marker: '◷' },
  executing: { label: 'Carrying out the plan', tone: 'working', marker: '·' },
  completed: { label: 'Done', tone: 'done', marker: '✓' },
  rejected: { label: 'Rejected by a person', tone: 'failed', marker: '×' },
  execution_failed: { label: 'Action failed', tone: 'failed', marker: '!' },
  expired: { label: 'Approval expired', tone: 'attention', marker: '◷' },
  archived: { label: 'Archived as noise', tone: 'done', marker: '✓' },
});

/** An unknown state degrades to readable text rather than raw snake_case. */
export function stateLabel(state: string): StatePresentation {
  return STATES[state] ?? { label: state.replace(/_/g, ' '), tone: 'working', marker: '·' };
}

// The reason a message was handed to a person. Shown beside the state, so it
// reads as a continuation of it: "Needs a person · the email may be trying to
// give the agent instructions".
const REVIEW_REASONS: Readonly<Record<string, string>> = Object.freeze({
  low_confidence: 'the assistant was not confident enough',
  insufficient_information: 'the email did not say enough to act on',
  ambiguous_intent: 'the request could be read more than one way',
  match_conflict: 'more than one CRM record could be the right one',
  possible_injection: 'the email may be trying to give the assistant instructions',
  draft_blocked: 'the drafted reply did not pass the content checks',
  execution_failed: 'an action failed and was rolled back',
  no_valid_plan: 'no safe plan could be produced',
  approval_expired: 'nobody approved it in time, so it was not carried out',
});

export function reviewReasonLabel(reason: string): string {
  return REVIEW_REASONS[reason] ?? reason.replace(/_/g, ' ');
}
