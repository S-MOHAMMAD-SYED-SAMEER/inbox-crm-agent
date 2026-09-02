// The frontend's half of the M5 authentication contract.
//
// WHAT THE BROWSER HOLDS, AND WHAT IT DELIBERATELY DOES NOT
//
// It does not hold the session. That lives in an `HttpOnly` cookie the browser
// attaches automatically and JavaScript cannot read — which is the point: an
// XSS bug cannot exfiltrate a session it has no way to see. Nothing in this
// directory tries to read it, and nothing stores a password anywhere.
//
// What the browser does hold is the CSRF token, in a *readable* cookie, because
// M5-B's double-submit scheme requires the front end to echo it back in a
// header. That is safe on its own: a cross-site page can cause the session
// cookie to be sent but cannot read this one to copy the value.
//
// AUTHENTICATION STATE IS THE SERVER'S ANSWER, NEVER A LOCAL GUESS
//
// `GET /api/auth/session` is the only source of "am I signed in?". The app asks
// at startup and after every sign-in, and believes the answer. There is no
// local flag that can drift out of step with the cookie, and no way to
// construct an authenticated-looking state without the server having said so.

/** The CSRF cookie M5-B sets alongside the session. Readable on purpose. */
export const CSRF_COOKIE = 'inbox_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Reads one cookie out of a `document.cookie` string.
 *
 * Pure, so it can be tested without a browser. Matches the whole name only —
 * a prefix match would let `inbox_csrf_other` masquerade as the real thing.
 */
export function readCookie(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(';')) {
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

/** The current CSRF token, or null when there is no session. */
export function currentCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  return readCookie(document.cookie, CSRF_COOKIE);
}

/**
 * Whether a request changes state and therefore needs a CSRF token.
 *
 * Mirrors M5-B's server rule. It is not a second mechanism — the server decides
 * and refuses; this only avoids sending a header where the server would ignore
 * it, and avoids omitting one where the server would refuse.
 */
export function needsCsrf(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  return verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS';
}

/** What `GET /api/auth/session` returns. */
export type SessionResponse = {
  authenticated: boolean;
  operator: string | null;
  expiresAt: string | null;
  csrfToken: string | null;
};

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  /**
   * Nobody is signed in, and the server has opened its read-only demo window
   * (P19). A fourth state rather than a flag on `anonymous`, because the app
   * genuinely behaves differently here and a boolean beside a status is the
   * kind of pair that drifts.
   *
   * It is not an authenticated state and must never be treated as one:
   * `isAuthenticated` returns false for it, there is no operator, and every
   * mutating control is hidden because the server would refuse it anyway.
   */
  | { status: 'public-demo' }
  | { status: 'authenticated'; operator: string; expiresAt: string | null };

/**
 * Turns the server's answer into application state.
 *
 * Pure and total: a malformed or partial body resolves to `anonymous` rather
 * than to a half-authenticated state. "I could not confirm you are signed in"
 * and "you are not signed in" must lead to the same screen, because acting on
 * the difference would mean guessing.
 */
export function sessionFromResponse(body: unknown): SessionState {
  if (!body || typeof body !== 'object') return { status: 'anonymous' };

  const response = body as Partial<SessionResponse>;
  if (response.authenticated !== true || typeof response.operator !== 'string' || response.operator === '') {
    return { status: 'anonymous' };
  }

  return {
    status: 'authenticated',
    operator: response.operator,
    expiresAt: typeof response.expiresAt === 'string' ? response.expiresAt : null,
  };
}

export function isAuthenticated(state: SessionState): boolean {
  return state.status === 'authenticated';
}

/**
 * Whether the server says its public read-only demo window is open (P19).
 *
 * Read from `/api/health`, which is public and already reports what the
 * deployment is configured for. Pure and total, and false for anything it does
 * not recognise: an unreachable or malformed health response must land on the
 * sign-in screen, never on a demo the server is not actually serving.
 */
export function publicDemoFromHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const adapters = (body as { adapters?: unknown }).adapters;
  if (!adapters || typeof adapters !== 'object') return false;
  return (adapters as Record<string, unknown>).demoPublicReadonly === true;
}

/** Whether the app should render the product without a session. */
export function isPublicDemo(state: SessionState): boolean {
  return state.status === 'public-demo';
}
