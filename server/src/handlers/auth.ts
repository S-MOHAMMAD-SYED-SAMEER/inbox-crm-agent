import { verifyPassword } from '../lib/password.ts';
import { OPERATOR_IDENTITY, type SessionRecord } from '../domain/session.ts';
import { ProblemCollector, requireObject, requireString } from '../lib/validate.ts';
import { AppError } from '../lib/errors.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { createLogger, type Logger } from '../lib/logger.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { AppConfig } from '../config/env.ts';
import type { HandlerResult } from './emails.ts';

// Sign in, sign out, and "who am I?" (M5-A).
//
// THE ONE THING THIS FILE MUST NOT DO IS BE HELPFUL ABOUT FAILURE.
//
// Wrong password, missing password, unconfigured server, malformed stored hash —
// every one of them answers with the same 401 and the same sentence. A response
// that distinguished them would tell someone guessing which half of the problem
// to work on, and "authentication is not configured" is a particularly useful
// thing to learn about a machine you are attacking.
//
// The token is returned exactly once, in a Set-Cookie header, by the route
// layer. It never appears in a response body and it is never logged.

export type AuthDeps = {
  repos: Repositories;
  config: AppConfig;
  clock?: Clock;
  logger?: Logger;
};

export type LoginResult = {
  token: string;
  session: SessionRecord;
  body: { operator: string; expiresAt: string };
};

/** The same answer for every way of failing to sign in. */
function unauthorized(): AppError {
  return new AppError('UNAUTHORIZED', 'That did not match. Check the password and try again.');
}

export async function handleLogin(deps: AuthDeps, input: unknown): Promise<LoginResult> {
  const { repos, config, clock = systemClock, logger = createLogger('auth') } = deps;

  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const password = requireString(body.password, 'password', problems, { maxLength: 512 });
  problems.throwIfAny();

  // An unconfigured server cannot authenticate anyone. It fails exactly like a
  // wrong password, and says so only in the log.
  if (config.operatorPasswordHash === null) {
    logger.error('Sign-in attempted but OPERATOR_PASSWORD_HASH is not set.');
    throw unauthorized();
  }

  if (!(await verifyPassword(password, config.operatorPasswordHash))) {
    // No operator name, no password, no length — nothing that helps a guess.
    logger.warn('Sign-in rejected.');
    throw unauthorized();
  }

  // Opportunistic housekeeping. Expired rows are already refused by the lookup,
  // so this is storage hygiene rather than a security step, and login is the
  // natural moment for it in a build with no background workers.
  await repos.sessions.deleteExpired(clock.nowIso());

  const { token, session } = await repos.sessions.create(OPERATOR_IDENTITY, config.sessionTtlHours);
  logger.info('Sign-in accepted.', { operator: session.operator });

  return {
    token,
    session,
    body: { operator: session.operator, expiresAt: session.expiresAt },
  };
}

/**
 * Signs out.
 *
 * Idempotent by design: signing out of a session that is already gone succeeds.
 * A logout that could fail is a logout someone stops trusting, and there is
 * nothing to protect — the caller already holds the token.
 */
export async function handleLogout(
  deps: Pick<AuthDeps, 'repos'>,
  token: string | null,
): Promise<HandlerResult<{ signedOut: boolean }>> {
  const signedOut = token === null ? false : await deps.repos.sessions.revoke(token);
  return { status: 200, body: { signedOut } };
}

/**
 * The current session, for the UI.
 *
 * Returns the operator, the expiry and the CSRF token — never the session token,
 * and never anything about the password. The CSRF token is safe to return: it
 * is worthless without the session cookie that accompanies it (M5-B).
 */
export function handleSession(session: SessionRecord | null): HandlerResult<{
  authenticated: boolean;
  operator: string | null;
  expiresAt: string | null;
  csrfToken: string | null;
}> {
  if (!session) {
    return { status: 200, body: { authenticated: false, operator: null, expiresAt: null, csrfToken: null } };
  }
  return {
    status: 200,
    body: {
      authenticated: true,
      operator: session.operator,
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
    },
  };
}
