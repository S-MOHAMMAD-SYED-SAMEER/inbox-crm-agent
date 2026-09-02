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
 * The read-only surface a public demo may expose (P19).
 *
 * A literal list, matched on method AND full path, and deliberately not derived
 * from the routers. Deriving it would mean a GET added later joined the public
 * surface the moment it was written; naming each one here means a new route is
 * private until somebody edits this array on purpose.
 *
 * Every entry is a projection the dashboard reads to draw itself. None of them
 * writes, and the CRM router is GET-only by construction.
 */
export const PUBLIC_DEMO_READS: readonly RegExp[] = [
  /^\/emails$/,
  /^\/emails\/[^/]+$/,
  /^\/approvals$/,
  /^\/(?:deals|contacts|companies|tasks|audit)$/,
];

/** Whether this exact request is one of the public reads. GET only. */
export function isPublicDemoRead(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return PUBLIC_DEMO_READS.some((pattern) => pattern.test(path));
}

/**
 * The gate, with an optional read-only window for the public demo (P19).
 *
 * WHY THIS REPLACES `requireSession` RATHER THAN SITTING BESIDE IT
 *
 * The alternative was to mount the read routes above the gate when the flag is
 * on. That splits the routers in two and makes the mounting order in `app.ts`
 * depend on configuration — and the property that file relies on is precisely
 * that everything after one line is protected. Keeping one gate keeps that
 * sentence true; the exception is visible inside it rather than hidden in a
 * conditional route table.
 *
 * WHAT AN ALLOWED REQUEST DOES NOT GET
 *
 * A session. `req.session` and `req.operator` stay undefined, so `operatorOf`
 * still throws for anyone who reaches it, every mutation still fails closed,
 * and the rate limiter still keys the caller by IP. This opens a window onto
 * synthetic data; it does not authenticate anybody.
 */
export function requireSessionOrPublicRead(options: { publicReadsEnabled: boolean }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.session) {
      next();
      return;
    }
    if (options.publicReadsEnabled && isPublicDemoRead(req.method, req.path)) {
      next();
      return;
    }
    next(new AppError('UNAUTHORIZED', 'Sign in to continue.'));
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
