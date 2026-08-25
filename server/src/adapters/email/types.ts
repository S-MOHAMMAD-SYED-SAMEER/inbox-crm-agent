import type { EmailSourceName } from '../../config/env.ts';
import type { CanonicalEmail } from '../../domain/email.ts';

// The email-source boundary (spec §23).
//
// Every implementation returns `CanonicalEmail`, so nothing downstream of
// ingestion knows whether a message came from a JSON fixture or from Gmail.
// That is the whole test for whether this boundary is drawn correctly: adding
// Gmail must not require editing the pipeline, the policy engine, the CRM
// layer, the audit log, or the UI.
//
// NOTE THE OPTIONAL `send`.
//
// It is optional on the interface deliberately. A source that can only read is
// a complete, valid implementation — read-only is the safe default, and here
// it is expressed in the type system rather than in a comment asking people to
// be careful. When Gmail sending is eventually built it will be a separate,
// separately-approved change, and a source without `send` simply cannot be
// asked to deliver mail.

export type OutboundEmail = {
  toEmail: string;
  subject: string;
  body: string;
  inReplyToProviderMessageId?: string | null;
};

export type FetchResult = {
  messages: CanonicalEmail[];
  /** Opaque continuation token; absent when there is nothing more to fetch. */
  cursor?: string;
};

export type EmailSource = {
  readonly name: EmailSourceName;
  /**
   * Messages received strictly after `since` (ISO-8601), oldest first.
   * Oldest-first matters: an inbox processed newest-first would answer this
   * morning's follow-up before the enquiry it follows up on.
   */
  fetchNew(since: string, options?: { cursor?: string; limit?: number }): Promise<FetchResult>;
  /** Marks a message handled so a later fetch does not return it again. */
  markProcessed(providerMessageId: string): Promise<void>;
  send?(message: OutboundEmail): Promise<{ providerMessageId: string }>;
};
