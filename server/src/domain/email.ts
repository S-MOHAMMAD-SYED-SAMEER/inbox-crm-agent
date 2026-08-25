// Email + agent-workflow vocabulary.
//
// Every closed set in this file is declared once, as a `const` tuple, and the
// TypeScript union is derived from it. That gives three things from one
// declaration: a compile-time union, a runtime guard, and an iterable list the
// migrations are checked against (test/domain.schema-parity.test.ts asserts
// these tuples match the SQL CHECK constraints exactly). A value can therefore
// never be legal in the database but unknown to the code, or the reverse.
//
// No TypeScript `enum` anywhere — `erasableSyntaxOnly` in tsconfig forbids it,
// because an enum is not erasable and would break Node's type stripping.

export const EMAIL_STATES = [
  'received',
  'understanding',
  'understand_failed',
  'resolving',
  'deciding',
  'awaiting_approval',
  'needs_review',
  'executing',
  'completed',
  'rejected',
  'execution_failed',
  'expired',
  'archived',
] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

export const REVIEW_REASONS = [
  'low_confidence',
  'insufficient_information',
  'ambiguous_intent',
  'match_conflict',
  'possible_injection',
  'draft_blocked',
  'execution_failed',
  'no_valid_plan',
  'approval_expired',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const EMAIL_CATEGORIES = [
  'sales_inquiry',
  'service_inquiry',
  'pricing_request',
  'support_request',
  'follow_up',
  'partnership',
  'vendor_pitch',
  'spam',
  'ambiguous',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const EMAIL_PROVIDERS = ['demo', 'gmail'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

// Confidence thresholds (spec §18). Bands exist because a band is what changes
// system behaviour; the raw number is shown alongside but never branched on
// outside this function, so there is exactly one place where "how confident is
// confident enough" is defined.
export const CONFIDENCE_THRESHOLDS = { high: 0.8, medium: 0.55 } as const;

export function confidenceBand(
  confidence: number,
  thresholds: { high: number; medium: number } = CONFIDENCE_THRESHOLDS,
): ConfidenceBand {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be a number in [0,1], received: ${String(confidence)}`);
  }
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.medium) return 'medium';
  return 'low';
}

/**
 * The canonical shape every email source adapter must produce (FR-3). Nothing
 * downstream of ingestion knows which provider a message came from.
 */
export type CanonicalEmail = {
  provider: EmailProvider;
  providerMessageId: string;
  threadId: string | null;
  fromName: string | null;
  fromEmail: string;
  toEmail: string;
  cc: string | null;
  subject: string;
  /** Sanitised plain text only — never HTML (FR-4). */
  bodyText: string;
  headers: Record<string, string>;
  receivedAt: string;
};

export type EmailRecord = CanonicalEmail & {
  id: string;
  ingestedAt: string;
  state: EmailState;
  reviewReason: ReviewReason | null;
  correlationId: string;
  /** True when the body was capped at ingestion (FR-4). Never silent. */
  bodyTruncated: boolean;
};
