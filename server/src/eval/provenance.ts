// Who wrote the data the evaluations are scored against.
//
// The demo emails, the scripted model answers stored beside them, the CRM seed, the
// evaluation datasets and the specification they follow were written by Claude (an AI
// assistant) under the project owner's direction. No person has reviewed them yet. Every
// evaluation report therefore carries this label, so a number is never read as accuracy
// against human-verified truth.

/** The label every result scored against the REVIEWED datasets carries (understand-1.1.0, resolve-1.1.0, decide-1.1.0). */
export const GOLD_LABEL =
  'scored against gold written by Claude; reviewed with AI assistance (Claude); final decisions approved by Sameer (not an independent human review)';

/** The label of everything scored against the first, unreviewed datasets, and of data nobody has reviewed (the injection set). */
export const LEGACY_GOLD_LABEL = 'scored against AI-written gold (Claude-written, not yet human-reviewed)';

export const GOLD_PROVENANCE =
  'The demo emails, their scripted model answers, the CRM seed, the evaluation datasets and the ' +
  'specification they follow were written by Claude (an AI assistant) under the project owner\'s ' +
  'direction. The three evaluation datasets were then reviewed with AI assistance (Claude) and the changes ' +
  'approved by Sameer on 2026-10-17; the emails, scripted answers, CRM seed and specification have not been ' +
  'reviewed. This is not an independent human review, and the expected outcomes are not independently verified truth.';

/** The lines every evaluation script prints before its results. */
export function goldBanner(): string[] {
  return [`  Gold data: ${GOLD_LABEL}`];
}
