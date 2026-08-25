import { config, type AppConfig } from '../../config/env.ts';
import { createMockOutboundSender } from './mock.ts';
import type { OutboundSender } from './types.ts';
import { outboundSendingPossible } from '../../domain/outbound.ts';
import type { OutboundContext, OutboundResult } from '../../domain/outbound.ts';
import type { OutboundEmail } from '../email/types.ts';

export type { OutboundSender } from './types.ts';
export { createMockOutboundSender } from './mock.ts';
export type { MockOutboundSender, MockSentMessage } from './mock.ts';

/**
 * The default sender: one that cannot send.
 *
 * A real object rather than a null or an optional method, so "sending is off"
 * is a code path that exists, is typed, is logged and is tested — instead of a
 * branch somebody has to remember to write at every call site.
 */
export function createDisabledOutboundSender(reason = 'outbound_send_disabled'): OutboundSender {
  return {
    name: 'none',
    enabled: false,
    async send(_message: OutboundEmail, _context: OutboundContext): Promise<OutboundResult> {
      return { ok: false, kind: 'blocked', message: reason };
    },
  };
}

/**
 * Chooses the sender for the current configuration.
 *
 * TWO LOCKS, BOTH SERVER-SIDE, AND THEY ARE AND-ED.
 *
 *   1. `ALLOW_OUTBOUND_SEND` must be true. Default false.
 *   2. `OUTBOUND_PROVIDER` must name a provider that exists. Default `none`.
 *
 * Either one left at its default means nothing can be delivered, so turning
 * sending on is a deliberate two-part act rather than a single flag somebody
 * flips while debugging. Neither is readable or writable from a browser: they
 * come from the process environment, and no request body is consulted here or
 * anywhere downstream.
 *
 * `gmail` is a declared provider name with no implementation, exactly as
 * `EMAIL_SOURCE=gmail` is: it falls back to disabled with a loud problem at
 * startup. That is the seam §23 asks for — a Gmail adapter arrives as a new
 * file implementing `OutboundSender`, and nothing else changes.
 */
export function createOutboundSender(cfg: AppConfig = config): OutboundSender {
  if (!outboundSendingPossible(cfg.allowOutboundSend, cfg.outboundProvider)) {
    if (!cfg.allowOutboundSend) return createDisabledOutboundSender('outbound_send_disabled');
    if (cfg.outboundProvider === 'gmail') return createDisabledOutboundSender('gmail_provider_not_implemented');
    return createDisabledOutboundSender('no_outbound_provider_configured');
  }

  return createMockOutboundSender({ behaviour: cfg.outboundMockBehaviour });
}
