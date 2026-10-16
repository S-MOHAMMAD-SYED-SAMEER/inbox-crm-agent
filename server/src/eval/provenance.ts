// Who wrote the data the evaluations are scored against.
//
// The demo emails, the scripted model answers stored beside them, the CRM seed, the
// evaluation datasets and the specification they follow were written by Claude (an AI
// assistant) under the project owner's direction. No person has reviewed them yet. Every
// evaluation report therefore carries this label, so a number is never read as accuracy
// against human-verified truth.

export const GOLD_LABEL = 'scored against AI-written gold (Claude-written, not yet human-reviewed)';

export const GOLD_PROVENANCE =
  'The demo emails, their scripted model answers, the CRM seed, the evaluation datasets and the ' +
  'specification they follow were written by Claude (an AI assistant) under the project owner\'s ' +
  'direction. No person has reviewed them yet. The expected outcomes are the author\'s reading of the ' +
  'specification, not independently verified truth.';

/** The lines every evaluation script prints before its results. */
export function goldBanner(): string[] {
  return [`  Gold data: ${GOLD_LABEL}`];
}
