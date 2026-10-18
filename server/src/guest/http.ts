import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { buildCookie, clearCookie, readCookie } from '../auth/cookies.ts';
import { isSafeMethod } from '../auth/csrf.ts';
import { CSRF_HEADER } from '../auth/csrf.ts';
import { secretsMatch } from '../domain/session.ts';
import { AppError } from '../lib/errors.ts';
import type { AppConfig } from '../config/env.ts';
import type { GuestManager } from './manager.ts';
import type { Recording } from './recording.ts';
import type { Sandbox } from './sandbox.ts';

// How a guest is recognised, kept apart from how the owner is.
//
// TWO IDENTITIES, ONE OF EACH PER REQUEST, NEVER MIXED
//
// The owner's session lives in the database and is resolved by `attachSession`, untouched by this file. A guest's lives in the
// guest registry, under cookies with their own names, resolved here. The two are independent:
//
//   * a guest cookie never produces an owner session, and an owner session is never replaced, refreshed or cleared by anything here;
//   * if a request carries both, the owner wins and the guest cookie is ignored;
//   * starting a guest session while signed in as the owner is refused, and sets no cookie at all;
//   * a guest signing out clears only the guest cookies.
//
// WHAT A GUEST NEVER SENDS
//
// No role, no sandbox id, no identifier of any kind. The cookie is a random token; the server looks the sandbox up from it. There is
// nothing in a request a guest could change to reach another sandbox or the owner's data.

export const GUEST_COOKIE = 'inbox_guest';
export const GUEST_CSRF_COOKIE = 'inbox_guest_csrf';

/** The label under which a guest's actions are recorded. A person actor with this id, shown as "Guest". */
export const GUEST_IDENTITY = 'guest';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set only when the request carries a live guest cookie and no owner session. */
    guest?: { sandbox: Sandbox; csrfToken: string };
  }
}

export type GuestInfo = {
  /** When the sandbox will be deleted if the guest does nothing. */
  expiresAt: string;
  /** When the recorded run the answers come from was made, and which model gave them. */
  recordedAt: string;
  model: string;
  run: string;
  idleMinutes: number;
  maxMinutes: number;
};

export function guestInfo(manager: GuestManager, recording: Recording, sandbox: Sandbox): GuestInfo {
  return {
    expiresAt: manager.expiresAt(sandbox),
    recordedAt: recording.provenance.recordedAt,
    model: recording.provenance.model,
    run: recording.provenance.run,
    idleMinutes: Math.round(manager.limits.idleMs / 60_000),
    maxMinutes: Math.round(manager.limits.maxAgeMs / 60_000),
  };
}

/** Recognises a guest from the cookie. Never rejects. An owner session, if there is one, is left exactly as it is and wins. */
export function attachGuest(manager: GuestManager) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session) {
        next();
        return;
      }
      const sandbox = await manager.lookup(readCookie(req.headers.cookie, GUEST_COOKIE));
      if (sandbox) {
        req.guest = { sandbox, csrfToken: sandbox.csrfToken };
        req.operator = GUEST_IDENTITY;
        // Asking "how long is left" must not extend the time left, or the banner would keep the sandbox alive forever.
        if (!(req.method === 'GET' && req.path === '/auth/session')) manager.touch(sandbox);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Paths a guest may POST before it has a session, or that carry no token for another reason. */
const GUEST_CSRF_EXEMPT = new Set(['/auth/guest']);

/** The same double-submit check the owner gets, against the guest's own token. */
export function requireGuestCsrf(): RequestHandler {
  return (req, _res, next) => {
    if (!req.guest || isSafeMethod(req.method) || GUEST_CSRF_EXEMPT.has(req.path)) {
      next();
      return;
    }
    const presented = req.headers[CSRF_HEADER];
    const token = typeof presented === 'string' ? presented : '';
    if (token === '' || !secretsMatch(token, req.guest.csrfToken)) {
      next(new AppError('FORBIDDEN', 'This request could not be verified. Reload the page and try again.', { details: { reason: 'csrf_token_invalid' } }));
      return;
    }
    next();
  };
}

/** After the gate: a guest's request is handled by its own sandbox and by nothing else. Everyone else carries on to the owner's routes. */
export function dispatchGuest(): RequestHandler {
  return (req, res, next) => {
    if (!req.guest) {
      next();
      return;
    }
    req.guest.sandbox.handle(req, res, next);
  };
}

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export type GuestRouterDeps = {
  manager: GuestManager;
  recording: Recording;
  config: Pick<AppConfig, 'cookieSecure' | 'guestDemo'>;
};

export function createGuestRouter({ manager, recording, config }: GuestRouterDeps): Router {
  const router = Router();
  const cookieMaxAge = Math.floor(manager.limits.maxAgeMs / 1000);
  const sessionCookie = { secure: config.cookieSecure, httpOnly: true, sameSite: 'Strict' as const };
  const csrfCookie = { secure: config.cookieSecure, httpOnly: false, sameSite: 'Strict' as const };

  router.post(
    '/auth/guest',
    wrap(async (req, res) => {
      if (!config.guestDemo) {
        throw new AppError('FORBIDDEN', 'The guest demo is turned off on this server.');
      }
      // One session per browser. An owner who is signed in is never turned into a guest, and nothing about the owner's cookies is
      // touched: this answers with no Set-Cookie at all.
      if (req.session) {
        throw new AppError('CONFLICT', 'You are signed in as the owner. Sign out first to try the guest demo.');
      }
      // Already a guest here: no second sandbox.
      if (req.guest) {
        res.status(200).json({ role: 'guest', guest: guestInfo(manager, recording, req.guest.sandbox) });
        return;
      }

      const { token, sandbox } = await manager.start(req.ip ?? req.socket.remoteAddress ?? 'unknown');
      res.setHeader('Set-Cookie', [
        buildCookie(GUEST_COOKIE, token, { ...sessionCookie, maxAgeSeconds: cookieMaxAge }),
        buildCookie(GUEST_CSRF_COOKIE, sandbox.csrfToken, { ...csrfCookie, maxAgeSeconds: cookieMaxAge }),
      ]);
      res.status(201).json({ role: 'guest', guest: guestInfo(manager, recording, sandbox) });
    }),
  );

  router.post(
    '/guest/reset',
    wrap(async (req, res) => {
      if (!req.guest) throw new AppError('UNAUTHORIZED', 'There is no guest demo session to start over.');
      await manager.reset(req.guest.sandbox);
      res.status(200).json({ reset: true, guest: guestInfo(manager, recording, req.guest.sandbox) });
    }),
  );

  router.post(
    '/guest/leave',
    wrap(async (req, res) => {
      const left = await manager.leave(readCookie(req.headers.cookie, GUEST_COOKIE));
      // Only the guest cookies are cleared. The owner's cookies are not named here and are never touched.
      res.setHeader('Set-Cookie', [clearCookie(GUEST_COOKIE, sessionCookie), clearCookie(GUEST_CSRF_COOKIE, csrfCookie)]);
      res.status(200).json({ left });
    }),
  );

  return router;
}
