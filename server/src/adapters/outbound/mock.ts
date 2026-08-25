import type { OutboundEmail } from '../email/types.ts';
import type { OutboundSender } from './types.ts';
import type { MockBehaviour, OutboundContext, OutboundResult } from '../../domain/outbound.ts';

// The mock outbound provider.
//
// Deterministic: the same message produces the same provider id, so a test can
// assert on it and a re-run of the suite produces identical rows. No network,
// no clock, no randomness.
//
// WHAT IT RECORDS, AND WHAT IT DOES NOT PRINT
//
// It keeps the subject, body and recipient of every call so a test can prove
// the *right* message went out — the v2 draft rather than the v1 one, for
// instance. It never logs them. Test output is scrollback, scrollback ends up
// in screenshots, and a customer's email body has no business in either.
// `describe()` below is what a failure message may safely print.

export type MockSentMessage = {
  toEmail: string;
  subject: string;
  body: string;
  providerMessageId: string;
  decisionId: string;
  idempotencyKey: string;
};

export type MockOutboundSender = OutboundSender & {
  /** Every call that reached the provider, successful or not. */
  readonly calls: readonly MockSentMessage[];
  /** Successful deliveries only. */
  readonly sent: readonly MockSentMessage[];
  behaviour: MockBehaviour;
  reset(): void;
  /** Recipient and subject only — safe to print in a failure message. */
  describe(): string[];
};

/** Stable, content-derived, and obviously not a real provider id. */
function providerIdFor(context: OutboundContext): string {
  return `mock-${context.idempotencyKey.slice(0, 16)}`;
}

export function createMockOutboundSender(
  options: { behaviour?: MockBehaviour; enabled?: boolean } = {},
): MockOutboundSender {
  const calls: MockSentMessage[] = [];
  const sent: MockSentMessage[] = [];

  const sender: MockOutboundSender = {
    name: 'mock',
    enabled: options.enabled ?? true,
    behaviour: options.behaviour ?? 'success',
    calls,
    sent,

    async send(message: OutboundEmail, context: OutboundContext): Promise<OutboundResult> {
      const record: MockSentMessage = {
        toEmail: message.toEmail,
        subject: message.subject,
        body: message.body,
        providerMessageId: providerIdFor(context),
        decisionId: context.decisionId,
        idempotencyKey: context.idempotencyKey,
      };
      calls.push(record);

      switch (sender.behaviour) {
        case 'success':
          sent.push(record);
          return { ok: true, providerMessageId: record.providerMessageId };
        case 'temporary_failure':
          return { ok: false, kind: 'temporary', message: 'The provider rejected the message and may accept a retry.' };
        case 'permanent_failure':
          return { ok: false, kind: 'permanent', message: 'The provider rejected the message permanently.' };
        case 'unavailable':
          return { ok: false, kind: 'unavailable', message: 'The provider could not be reached.' };
        case 'timeout':
          return { ok: false, kind: 'timeout', message: 'The provider did not answer in time.' };
      }
    },

    reset(): void {
      calls.length = 0;
      sent.length = 0;
    },

    describe(): string[] {
      return calls.map((call) => `${call.toEmail} — "${call.subject}"`);
    },
  };

  return sender;
}
