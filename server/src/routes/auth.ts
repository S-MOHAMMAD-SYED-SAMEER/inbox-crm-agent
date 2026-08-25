import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleLogin, handleLogout, handleSession, type AuthDeps } from '../handlers/auth.ts';
import { buildCookie, clearCookie, readCookie, CSRF_COOKIE, SESSION_COOKIE } from '../auth/cookies.ts';

// Authentication routes (M5-A).
//
// These three are the only endpoints reachable without a session, which is why
// they live in their own router mounted before the gate.
//
// THE COOKIE PAIR
//
//   inbox_session  HttpOnly — the bearer credential. JavaScript must never be
//                  able to read it, so an XSS bug cannot exfiltrate a session.
//   inbox_csrf     readable — the CSRF token (M5-B). Deliberately NOT HttpOnly,
//                  because the front end has to echo it back in a header. It is
//                  worthless on its own: a cross-site page can cause the session
//                  cookie to be sent but cannot read this one to copy it.
//
// Both are `SameSite=Strict`. This application is its own front end with no
// third-party sign-in flow, so there is no cross-site navigation that needs to
// arrive authenticated — and Strict is the setting that makes CSRF hard before
// the token is even considered.

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export function createAuthRouter(deps: AuthDeps): Router {
  const router = Router();

  const sessionCookieOptions = {
    secure: deps.config.cookieSecure,
    httpOnly: true,
    sameSite: 'Strict' as const,
  };
  const csrfCookieOptions = {
    secure: deps.config.cookieSecure,
    httpOnly: false,
    sameSite: 'Strict' as const,
  };

  router.post(
    '/auth/login',
    wrap(async (req, res) => {
      const result = await handleLogin(deps, req.body);
      const maxAgeSeconds = deps.config.sessionTtlHours * 3600;

      res.setHeader('Set-Cookie', [
        buildCookie(SESSION_COOKIE, result.token, { ...sessionCookieOptions, maxAgeSeconds }),
        buildCookie(CSRF_COOKIE, result.session.csrfToken, { ...csrfCookieOptions, maxAgeSeconds }),
      ]);
      // The token is in the header and nowhere else. The body carries only what
      // the UI needs to render a signed-in state.
      res.status(200).json(result.body);
    }),
  );

  router.post(
    '/auth/logout',
    wrap(async (req, res) => {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const result = await handleLogout(deps, token);

      // Cleared with the same attributes they were set with, or the browser
      // keeps them.
      res.setHeader('Set-Cookie', [
        clearCookie(SESSION_COOKIE, sessionCookieOptions),
        clearCookie(CSRF_COOKIE, csrfCookieOptions),
      ]);
      res.status(result.status).json(result.body);
    }),
  );

  // Safe to call unauthenticated: it answers "no" rather than 401, which is what
  // lets the front end decide between a sign-in screen and the app.
  router.get('/auth/session', (req: Request, res: Response) => {
    const result = handleSession(req.session ?? null);
    res.status(result.status).json(result.body);
  });

  return router;
}
