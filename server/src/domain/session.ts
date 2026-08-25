import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Session vocabulary (M5-A).
//
// THE TOKEN IS NEVER STORED.
//
// The cookie carries a random token; the database stores only its SHA-256.
// Lookup hashes the presented token and compares. The consequence is the point:
// a leaked database — a backup, a dump, a `SELECT *` in a support session —
// yields no usable session, because the stored value cannot be replayed as a
// cookie. It is the same reasoning as never storing a plaintext password, and
// it costs one hash per request.
//
// A session id is a bearer credential. Everything below treats it like one:
// high entropy, never logged, never in a URL, never in a response body.

/** 32 bytes from the CSPRNG — 256 bits, base64url. Unguessable by construction. */
const TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** What the database stores in place of the token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison for session-adjacent secrets (CSRF tokens in M5-B).
 *
 * Length is compared first because `timingSafeEqual` throws on a mismatch —
 * and that length check leaks only the length, which is fixed anyway.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type SessionRecord = {
  /** SHA-256 of the token. The token itself exists only in the cookie. */
  tokenHash: string;
  /** The authenticated operator this session speaks for. */
  operator: string;
  /** CSRF token for this session (M5-B). Not a bearer credential on its own. */
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
};

/** The single operator identity this build authenticates. */
export const OPERATOR_IDENTITY = 'operator';

export function isExpired(session: Pick<SessionRecord, 'expiresAt'>, now: string): boolean {
  return session.expiresAt <= now;
}
