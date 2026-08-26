// How a batch run reports itself (M7-F).
//
// Pure, so it can be tested without a browser (NFR-9).
//
// WHY THIS EXISTS
//
// The Decide button used to render this, and only this:
//
//   `Decided ${result.decided} email(s); ${result.awaitingApproval} waiting for approval.`
//
// The endpoint also returns `failed` and `noPlan`, and both were dropped. So a
// batch in which every single email threw reported:
//
//   "Decided 0 email(s); 0 waiting for approval."
//
// — which is the same sentence a batch with nothing to do produces. In
// production that sentence hid seven consecutive failures behind wording that
// reads like success, and cost a full investigation to unpick.
//
// The rule here is therefore narrow and absolute: **a batch that failed must
// never produce a sentence that reads like one that succeeded.** Zero work done
// and work attempted-and-failed are different events and must say different
// things.

export type DecideBatchResult = {
  decided: number;
  awaitingApproval: number;
  noPlan: number;
  failed: number;
};

/**
 * The sentence shown after a Decide run.
 *
 * Failures lead. Everything else is detail, and detail that is zero is left out
 * rather than padding the line with noise.
 */
export function describeDecideBatch(result: DecideBatchResult): string {
  const { decided, awaitingApproval, noPlan, failed } = result;

  // Nothing attempted at all. Distinct from "attempted and failed", which is
  // the distinction the old message could not make.
  if (decided === 0 && failed === 0) {
    return 'Nothing was waiting to be decided.';
  }

  // Nothing succeeded, and it was not for lack of trying. Say so first and do
  // not lead with a count of zero, which reads as success.
  if (decided === 0 && failed > 0) {
    return `${failed} email(s) could not be decided. Nothing was changed — check the server log.`;
  }

  const parts = [`Decided ${decided} email(s)`, `${awaitingApproval} waiting for approval`];
  if (noPlan > 0) parts.push(`${noPlan} had no valid plan and went to a person`);
  if (failed > 0) parts.push(`${failed} could not be decided — check the server log`);

  return `${parts.join('; ')}.`;
}
