// Bounding an audit payload (M5-F, audit F-13).
//
// THE POLICY, STATED ONCE
//
//   1. Identifier-shaped keys are never truncated. A decision id cut in half is
//      not a shorter identifier, it is a wrong one — and correlating an incident
//      later is the entire reason the payload exists.
//   2. Every other string is capped, with the truncation marked in the value so
//      nobody reads a shortened string as the whole thing.
//   3. Arrays are capped by length, with the count of what was dropped kept.
//   4. If the result is still too large, the payload is replaced by a stub that
//      records what happened and what it referred to. Losing the detail is
//      acceptable; losing the event is not.
//
// WHY A CAP AT ALL
//
// Nothing today writes a large payload — current callers pass ids, codes and
// path lists. The cap exists so that a future caller passing something large
// does not quietly bloat a table that is append-only and never pruned. An
// append-only log with an unbounded row size is a disk-usage incident waiting
// for a busy week.
//
// This is NOT where message content is kept out of the audit log. That rule
// lives at every call site, which passes guardrail names, path lists and digests
// rather than text (§19). This is a size bound, not a privacy bound — and the
// difference matters, because a cap that silently truncated an email body would
// still have stored an email body.

/** Bytes of serialised JSON a payload may occupy. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

/** Longest string value kept intact. */
export const MAX_STRING_LENGTH = 512;

/** Longest array kept intact. */
export const MAX_ARRAY_LENGTH = 50;

export const TRUNCATION_MARKER = '…[truncated]';

/**
 * Keys whose values are identifiers and must survive intact.
 *
 * Matched on the camelCase boundary — `Id`, `Hash`, `Digest`, `Key` — plus the
 * bare key `id`. The capital matters: a case-insensitive suffix match would
 * also catch `valid`, `overhead` and `monkey`, and quietly exempt them from the
 * cap they should be subject to.
 */
function isIdentifierKey(key: string): boolean {
  return key === 'id' || /(?:Id|Ids|Hash|Key|Digest)$/.test(key);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return value.slice(0, MAX_STRING_LENGTH) + TRUNCATION_MARKER;
}

function bound(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    // Identifiers pass through whole. A half-written id is a wrong id.
    return isIdentifierKey(key) ? value : truncateString(value);
  }

  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_LENGTH) return value.map((item) => bound(item, key));
    return [
      ...value.slice(0, MAX_ARRAY_LENGTH).map((item) => bound(item, key)),
      `${TRUNCATION_MARKER} ${value.length - MAX_ARRAY_LENGTH} more`,
    ];
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        bound(childValue, childKey),
      ]),
    );
  }

  return value;
}

export type BoundedPayload = {
  payload: Record<string, unknown>;
  /** True when anything was dropped, so a reader knows not to trust completeness. */
  truncated: boolean;
};

/**
 * Applies the policy above to one payload.
 *
 * Returns the payload it will store and whether anything was lost. The caller
 * writes it as-is: this function makes the decision, the repository does not.
 */
export function boundAuditPayload(payload: Record<string, unknown> | undefined): BoundedPayload {
  if (!payload) return { payload: {}, truncated: false };

  const original = JSON.stringify(payload);
  if (original !== undefined && Buffer.byteLength(original, 'utf8') <= MAX_PAYLOAD_BYTES) {
    return { payload, truncated: false };
  }

  const reduced = bound(payload, '') as Record<string, unknown>;
  const serialised = JSON.stringify(reduced);

  if (serialised !== undefined && Buffer.byteLength(serialised, 'utf8') <= MAX_PAYLOAD_BYTES) {
    return { payload: { ...reduced, payloadTruncated: true }, truncated: true };
  }

  // Still oversized. Keep the identifiers and drop the rest: an event with a
  // stub payload is recoverable, a missing event is not.
  const identifiers = Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => isIdentifierKey(key) && typeof value === 'string'),
  );

  return {
    payload: {
      ...identifiers,
      payloadTruncated: true,
      payloadDropped: true,
      originalBytes: original === undefined ? null : Buffer.byteLength(original, 'utf8'),
    },
    truncated: true,
  };
}
