// How a blocked prompt-injection attempt is explained.
//
// Pure, so it can be tested without a browser.
//
// THIS IS THE STRONGEST MOMENT IN THE DEMO, AND IT HAS TO BE TRUE
//
// The email that tries to give the agent orders is caught, quarantined, and no action is taken. The point to make is that
// the check does not depend on the model noticing: it runs on every email, separately from the model, and its verdict
// overrides the model's.
//
// An earlier version of this text claimed an ordering: that the check came first, ahead of the model. That was false. The model
// reads the email first, and the check runs afterwards, on the stored text, and a verdict from either one is enough to stop
// the email. The strength of the design is that the two are independent, not that one comes first. The wording below says
// exactly that and no more, and a test pins it.

export type InjectionDefence = {
  headline: string;
  detail: string;
};

/**
 * How the catch is described, given whether the model also flagged it.
 *
 * Both branches say the same true thing, a check outside the model caught it, because in both branches that is what
 * happened. The model agreeing is a second opinion, never the reason the email was stopped.
 */
export function describeDefence(modelFlagged: boolean): InjectionDefence {
  return {
    headline: 'Caught by a security check that runs on every email',
    detail: modelFlagged
      ? "This check runs on every email, separately from the AI, and its verdict overrides the AI's. Here the AI flagged it as well."
      : "This check runs on every email, separately from the AI, and its verdict overrides the AI's. It does not depend on the AI noticing, as here, where it did not.",
  };
}
