import type { NextFunction, Request, Response } from 'express';
import { readCookie, SESSION_COOKIE } from './cookies.ts';
import { AppError } from '../lib/errors.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { SessionRecord } from '../domain/session.ts';

// The authentication boundary (M5-A).
//
// WHAT CHANGED, AND WHY IT MATTERS MORE THAN IT LOOKS
//
// Operator identity used to come from an `x-operator` header. Anyone could set
// it to anything, so every approval, revision and audit event recorded a claim
// rather than an actor — and "who approved this?" is one of the three things
// this product actually sells.
//
// After this file, identity comes from the session and from nowhere else.
// `x-operator` is not merely deprioritised, it is not read: `attachSession`
// below sets `req.operator`, and the route layer reads that. A request may
// still carry the header; it will have no effect on anything.
//
// TWO MIDDLEWARES, NOT ONE
//
// `attachSession` resolves a session if one is presented and never rejects —
// so `/api/auth/session` can answer "not signed in" rather than 401, and so the
// CSRF layer (M5-B) has the session available to compare against.
// `requireSession` is the gate. Splitting them keeps "who is this?" separate
// from "may they?", which is the same separation the executor draws between
// verification and authorisation.

declare module 'express-serve-static-core' {
  interface Request {
    /** The live session, when one was presented. Set by `attachSession`. */
    session?: SessionRecord;
    /** The authenticated operator. Never derived from a header. */
    operator?: string;
  }
}

export type AuthMiddlewareDeps = {
  repos: Repositories;
  clock?: Clock;
};

/**
 * Resolves a session from the cookie, if there is one. Never rejects.
 *
 * An expired or unknown token is indistinguishable from no token at all: the
 * repository applies expiry in its query, so this function has no way to tell
 * them apart and therefore no way to leak the difference.
 */
export function attachSession({ repos, clock = systemClock }: AuthMiddlewareDeps) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (token) {
        const session = await repos.sessions.findLive(token, clock.nowIso());
        if (session) {
          req.session = session;
          req.operator = session.operator;
          // Activity, not extension. A session's lifetime is fixed at creation.
          await repos.sessions.touch(session.tokenHash);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Requires an authenticated session.
 *
 * The 401 body says only that sign-in is needed. It does not say whether a
 * cookie was presented, whether it was expired, or whether the server has a
 * password configured at all — each of which would tell someone probing which
 * half of the problem to work on.
 */
export function requireSession() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session) {
      next(new AppError('UNAUTHORIZED', 'Sign in to continue.'));
      return;
    }
    next();
  };
}

/**
 * The authenticated operator for a request.
 *
 * The single place the rest of the server asks "who is doing this?". It reads
 * `req.operator`, which only `attachSession` sets, which only reads the session
 * cookie. There is deliberately no header fallback: a fallback is exactly how
 * the old impersonation hole worked.
 */
export function operatorOf(req: Request): string {
  const operator = req.operator;
  if (!operator) {
    // Unreachable behind `requireSession`, and an assertion rather than a
    // default because a silent 'operator' fallback here would quietly restore
    // the anonymous-actor problem this milestone exists to remove.
    throw new AppError('UNAUTHORIZED', 'Sign in to continue.');
  }
  return operator;
}
