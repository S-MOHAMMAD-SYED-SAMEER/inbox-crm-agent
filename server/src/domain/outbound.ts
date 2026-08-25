// Outbound delivery vocabulary (FR-32, spec §23).
//
// Pure domain, no imports: the configuration layer reads these to validate the
// environment, and the adapter layer reads them to implement it. Putting them
// here rather than in the adapter is what keeps `config → adapter → config`
// from becoming a cycle, and it matches how autonomy levels already work.

export const OUTBOUND_PROVIDERS = ['none', 'mock', 'gmail'] as const;
export type OutboundProviderName = (typeof OUTBOUND_PROVIDERS)[number];

/**
 * Behaviours the mock provider can be asked to exhibit.
 *
 * Failure handling is not something to find out about in production. These let
 * every branch of it be demonstrated — and tested — with no provider, no
 * credentials and no network.
 */
export const MOCK_BEHAVIOURS = [
  'success',
  'temporary_failure',
  'permanent_failure',
  'unavailable',
  'timeout',
] as const;
export type MockBehaviour = (typeof MOCK_BEHAVIOURS)[number];

/**
 * Why a send did not succeed.
 *
 * Split by what an operator should do about it rather than by what went wrong
 * technically. `temporary`, `unavailable` and `timeout` are worth retrying;
 * `permanent` and `blocked` are not, and retrying them would produce the same
 * answer more slowly.
 */
export const OUTBOUND_FAILURE_KINDS = ['temporary', 'permanent', 'unavailable', 'timeout', 'blocked'] as const;
export type OutboundFailureKind = (typeof OUTBOUND_FAILURE_KINDS)[number];

export function isRetryable(kind: OutboundFailureKind): boolean {
  return kind === 'temporary' || kind === 'unavailable' || kind === 'timeout';
}

export type OutboundResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; kind: OutboundFailureKind; message: string };

/**
 * What a sender is told about a message's provenance.
 *
 * Identifiers only. A provider adapter may legitimately tag a message with the
 * decision it came from; it has no business knowing anything about the
 * customer beyond the address it delivers to.
 */
export type OutboundContext = {
  emailId: string;
  decisionId: string;
  /** The action's content-derived key, so a provider can deduplicate too. */
  idempotencyKey: string;
};

/**
 * Whether this configuration can deliver mail at all.
 *
 * One definition, read by the adapter factory that builds the sender and by
 * the config summary that reports the capability. Two definitions would
 * eventually disagree, and the disagreement people notice is the one where the
 * dashboard says "disabled" while messages are going out.
 */
export function outboundSendingPossible(allow: boolean, provider: OutboundProviderName): boolean {
  return allow && provider === 'mock';
}
