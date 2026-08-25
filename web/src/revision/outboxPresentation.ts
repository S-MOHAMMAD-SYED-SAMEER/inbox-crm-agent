import type { Outbox } from '../api/types.ts';

// How a reply's delivery status is described (M4-D §16).
//
// One rule governs every line below: **never say "sent" unless the server said
// it was sent**. Drafted, approved, queued, suppressed and failed are five
// different things, and a screen that blurs them into "done" is how someone
// tells a customer an email went out that never did.
//
// `sent` is the only status that may use the word. It is reachable only when
// the operator turned on two server-side settings, a human approved the plan,
// and a provider accepted the message.

export type OutboxTone = 'sent' | 'held' | 'failed';

export type OutboxPresentation = {
  /** Headline. Reads as a fact, not a promise. */
  title: string;
  detail: string;
  tone: OutboxTone;
  /** A shape cue, so the status never depends on colour alone. */
  marker: string;
  /** True only when the server confirmed delivery. */
  delivered: boolean;
};

const FAILURE_DETAIL: Record<string, string> = {
  temporary: 'The provider would not take it just now. It can be retried.',
  unavailable: 'The provider could not be reached. It can be retried.',
  timeout: 'The provider did not answer in time. It can be retried.',
  permanent: 'The provider refused it outright. Retrying will not help.',
  recipient_mismatch: 'The recipient did not match the approved plan, so it was stopped.',
};

export function presentOutbox(outbox: Outbox, providerLabel = 'demo provider'): OutboxPresentation {
  switch (outbox.status) {
    case 'sent':
      return {
        title: `Sent via ${providerLabel}`,
        detail: 'The reply was delivered. This is the only status that means the customer has it.',
        tone: 'sent',
        marker: '✓',
        delivered: true,
      };

    case 'suppressed':
      return {
        title: 'Outbound sending disabled',
        detail:
          'The reply is written and waiting, and nothing was delivered. ' +
          'Sending stays off until it is turned on in the server configuration.',
        tone: 'held',
        marker: '⦸',
        delivered: false,
      };

    case 'failed':
      return {
        title: 'Not delivered',
        detail: FAILURE_DETAIL[outbox.suppressedReason ?? ''] ?? 'The reply could not be delivered.',
        tone: 'failed',
        marker: '!',
        delivered: false,
      };

    case 'queued':
    default:
      return {
        // Deliberately avoids the word "sent" altogether. A status line is
        // skimmed, and "waiting to be sent" is one careless glance away from
        // reading as "sent".
        title: 'Waiting in the outbox',
        detail: 'The reply is written and has not been delivered.',
        tone: 'held',
        marker: '·',
        delivered: false,
      };
  }
}
