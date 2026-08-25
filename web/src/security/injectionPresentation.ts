// How a blocked prompt-injection attempt is explained (M6-E).
//
// Pure, so it can be tested without a browser (NFR-9).
//
// THIS IS THE STRONGEST MOMENT IN THE DEMO AND IT WAS BEING UNDERSOLD
//
// The email that tries to give the agent orders is caught, quarantined, and no
// action is taken. The screen said so — in the system's own vocabulary:
//
//   "The agent itself did not flag this — the deterministic detector did."
//
// Two things were wrong with that sentence. "Deterministic detector" is
// engineering language. And its shape leads with a miss: the first clause a
// person reads is that the agent failed to notice, which is the opposite of the
// point being made.
//
// The point is that the check does not depend on the model noticing. That is a
// design guarantee — a scan runs over every email before the model's opinion is
// consulted, so an attempt gets caught whether or not the model was fooled. Say
// that first, and the same fact becomes the reassurance it always was.

export type InjectionDefence = {
  headline: string;
  detail: string;
};

/**
 * How the catch is described, given whether the model also flagged it.
 *
 * Both branches say the same true thing — a check outside the model caught it —
 * because in both branches that is what happened. The model agreeing is a
 * second opinion, never the reason the email was stopped.
 */
export function describeDefence(modelFlagged: boolean): InjectionDefence {
  return {
    headline: 'Caught by a security check that runs on every email',
    detail: modelFlagged
      ? 'The check runs before the AI is asked for its opinion, so it does not depend on the AI noticing. Here the AI flagged it as well.'
      : 'The check runs before the AI is asked for its opinion, so it does not depend on the AI noticing — as here, where it did not.',
  };
}
