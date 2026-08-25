// Cookie handling, hand-written.
//
// `cookie-parser` would be a dependency for twenty lines of string splitting,
// and this project has three server dependencies on purpose. Parsing a Cookie
// header is not the hard part of authentication.

export const SESSION_COOKIE = 'inbox_session';
export const CSRF_COOKIE = 'inbox_csrf';

/**
 * Reads one cookie from a raw `Cookie` header.
 *
 * Values are decoded, and a malformed encoding yields the raw value rather than
 * throwing — a bad cookie should fail authentication, not crash the request.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;

    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export type CookieOptions = {
  maxAgeSeconds: number;
  secure: boolean;
  /** False for the CSRF cookie, which the browser must be able to read. */
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

/**
 * Builds a Set-Cookie value.
 *
 * `Path=/` so one cookie covers the API and the app. `SameSite` is a caller
 * decision because the session cookie and the CSRF cookie want different
 * answers — see `session.ts` for which and why.
 */
export function buildCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Expires a cookie immediately, matching the attributes it was set with. */
export function clearCookie(name: string, options: Omit<CookieOptions, 'maxAgeSeconds'>): string {
  return buildCookie(name, '', { ...options, maxAgeSeconds: 0 });
}
