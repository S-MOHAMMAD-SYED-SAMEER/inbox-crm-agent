import type { OutboundEmail } from '../email/types.ts';
import type { OutboundContext, OutboundProviderName, OutboundResult } from '../../domain/outbound.ts';

// THE OUTBOUND BOUNDARY (spec §23, FR-32).
//
// This is the narrowest interface in the codebase, and that is the point.
// Everything it does is *deliver a message someone else already decided to
// send*. It has no opinion about whether the message should exist.
//
// WHAT A SENDER MAY NOT DO
//
//   * decide whether to send — the executor decides, after re-verifying the
//     approval, the plan fingerprint and the draft guardrails
//   * choose a recipient — the address comes from the approved plan
//   * touch the CRM, an approval, a decision or the outbox
//   * see anything about the email beyond the message it is handed
//
// A sender that could do any of those would be a second execution path, and a
// second execution path is where a bypass grows. This one takes a message and
// reports what the provider said. That is all.
//
// WHY `enabled` IS ON THE INTERFACE
//
// So "can this system send mail?" is a value that can be read, logged and
// asserted on, rather than a fact spread across two environment variables and
// a switch statement. The disabled sender is a real implementation that always
// refuses — not a null, not an optional method, not a branch somebody could
// forget to write.

export type OutboundSender = {
  readonly name: OutboundProviderName;
  /** False means this sender will refuse everything. The default. */
  readonly enabled: boolean;
  send(message: OutboundEmail, context: OutboundContext): Promise<OutboundResult>;
};
