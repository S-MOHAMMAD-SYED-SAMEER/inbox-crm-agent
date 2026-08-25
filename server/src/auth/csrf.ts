import type { NextFunction, Request, Response } from 'express';
import { secretsMatch } from '../domain/session.ts';
import { AppError } from '../lib/errors.ts';

// CSRF protection (M5-B).
//
// WHY THIS IS NEEDED AT ALL, GIVEN SameSite=Strict
//
// The session cookie is already `SameSite=Strict`, which means a browser will
// not attach it to a cross-site request — and that alone defeats classic CSRF.
// This layer exists because `SameSite` is a browser promise, and the things it
// does not cover are exactly the things worth defending: an older browser that
// ignores the attribute, a same-site subdomain that turns hostile, and any
// future need to relax `SameSite` for an OAuth redirect (which Gmail will bring).
// Defence that depends on one mechanism fails when that mechanism is relaxed.
//
// THE SCHEME: per-session token, double-submitted
//
// Each session carries a random `csrf_token`, issued at sign-in in a *readable*
// cookie. A state-changing request must echo it in `x-csrf-token`. A cross-site
// page can cause the session cookie to be sent, but the same-origin policy stops
// it reading the CSRF cookie to copy the value — so it cannot produce the header.
//
// The token is bound to the session, not global: it dies with the session, and
// one session's token is useless with another's cookie.
//
// WHAT IS EXEMPT, AND WHY
//
//   GET / HEAD / OPTIONS — no state changes. If one of these ever mutates
//     something, the bug is the mutation, not this exemption.
//   POST /auth/login — there is no session yet, so there is no token to echo.
//     Login CSRF (forcing a victim into the attacker's session) is not
//     meaningful here: there is one operator and one credential, so an attacker
//     who could log someone in would have to already know the password.
//
// Logout is NOT exempt. It has a session, and being forcibly signed out by a
// cross-site page is a nuisance worth preventing.

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths that cannot carry a CSRF token because they precede the session. */
const EXEMPT_PATHS = new Set(['/auth/login']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export function isCsrfExempt(method: string, path: string): boolean {
  return isSafeMethod(method) || EXEMPT_PATHS.has(path);
}

/**
 * Requires a valid per-session CSRF token on state-changing requests.
 *
 * Runs after `attachSession` and before the routes. A request with no session
 * falls through untouched — `requireSession` is what rejects that, and having
 * two layers answer the same question with different codes would make a 401
 * and a 403 mean the same thing.
 */
export function requireCsrf() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (isCsrfExempt(req.method, req.path)) {
      next();
      return;
    }

    // No session: not this layer's refusal to make.
    if (!req.session) {
      next();
      return;
    }

    const presented = req.headers[CSRF_HEADER];
    const token = typeof presented === 'string' ? presented : '';

    if (token === '' || !secretsMatch(token, req.session.csrfToken)) {
      // 403, not 401: the caller IS signed in. Telling them to sign in again
      // would send them round a loop that cannot fix the problem.
      next(
        new AppError('FORBIDDEN', 'This request could not be verified. Reload the page and try again.', {
          details: { reason: 'csrf_token_invalid' },
        }),
      );
      return;
    }

    next();
  };
}
