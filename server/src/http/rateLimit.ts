import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { isPublicDemoRead } from '../auth/middleware.ts';

// Rate limiting (M5-C, audit F-02, spec §11).
//
// IN-MEMORY AND SINGLE-PROCESS. THIS IS NOT DISTRIBUTED RATE LIMITING.
//
// Counters live in this process's heap. Two instances behind a load balancer
// each enforce the limit separately, so the effective limit is the configured
// one multiplied by the instance count, and a restart forgets everything. That
// is stated plainly because a limiter people believe is stronger than it is is
// worse than none: it invites the assumption that the API is protected from
// abuse when it is protected only from accidents and casual scripts.
//
// It is the right shape for this application today — one process, one operator,
// no Redis — and the spec asked for exactly this. When it needs to be real,
// the interface below is what a shared store would implement.
//
// WHY A FIXED WINDOW AND NOT A TOKEN BUCKET
//
// A fixed window is trivially explainable ("20 in a minute"), trivially
// testable, and its worst case — twice the limit across a window boundary — is
// irrelevant at these numbers. A token bucket would be more elegant and would
// buy nothing here.
//
// THE KEY IS DERIVED SERVER-SIDE, ALWAYS.
//
// Session identity when authenticated, remote address when not. Never a header:
// `x-operator` was the reason F-01 existed, and a limiter keyed on anything the
// caller can set is a limiter the caller can step around by changing it.

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. For `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * A fixed-window counter keyed by an opaque string.
 *
 * Exported so it can be tested as a pure unit with an injected clock — the
 * behaviour that matters (a window resetting, two clients not colliding) should
 * not need an HTTP server to verify.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly clock: Clock;

  // A plain assignment rather than a parameter property: this project runs
  // TypeScript through Node's type stripping (`erasableSyntaxOnly`), which
  // forbids syntax that emits code.
  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = Date.parse(this.clock.nowIso());
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
    }

    existing.count++;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

    if (existing.count > rule.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    return { allowed: true, remaining: rule.limit - existing.count, retryAfterSeconds };
  }

  /**
   * Drops windows that have already reset.
   *
   * Without this the map grows once per distinct key forever, which for
   * IP-keyed login attempts is an unbounded allocation driven by strangers.
   */
  prune(): number {
    const now = Date.parse(this.clock.nowIso());
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.windows.size;
  }

  reset(): void {
    this.windows.clear();
  }
}

/**
 * The three classes of traffic, per spec §11.
 *
 * `expensive` is the one that matters most: those endpoints call a model, so
 * exceeding them costs real money rather than merely load. That is why its
 * limit is the tightest of the three.
 */
export const RATE_LIMITS = Object.freeze({
  login: { limit: 10, windowMs: 60_000 },
  expensive: { limit: 20, windowMs: 60_000 },
  mutation: { limit: 120, windowMs: 60_000 },
  /**
   * Anonymous reads of the public demo (P19).
   *
   * Reads are otherwise unlimited on purpose — see `classify` — and that was
   * correct while a read required a session, because the population was one
   * operator. With DEMO_PUBLIC_READONLY on, eight GETs face the internet, and
   * an unlimited endpoint in front of a free-tier database is a denial-of-
   * service waiting to be discovered.
   *
   * 60 a minute is chosen against the actual traffic: a visitor clicking every
   * one of the eight sections twice spends about twenty, so this is roughly
   * three times what a person browsing hard would use, while capping a scraper
   * at one request a second. Deliberately looser than `expensive` (no model
   * call, no spend) and tighter than `mutation`.
   */
  publicRead: { limit: 60, windowMs: 60_000 },
} satisfies Record<string, RateLimitRule>);

export type RateLimitClass = keyof typeof RATE_LIMITS;

/** Endpoints that trigger a model call, and therefore spend. */
const EXPENSIVE_PATHS = [/^\/emails\/understand$/, /^\/emails\/[^/]+\/understand$/, /^\/emails\/decide$/, /^\/emails\/[^/]+\/decide$/];

/**
 * What the limiter needs to know beyond the method and path (P19).
 *
 * Both fields default to the pre-P19 answer, so `classify(method, path)` with
 * no context behaves exactly as it always did — which is what every existing
 * caller and test relies on.
 */
export type ClassifyContext = {
  /** Whether the public demo window is open. Off unless an operator opened it. */
  publicReadsEnabled?: boolean;
  /** Whether this request carries a live session. */
  authenticated?: boolean;
};

export function classify(
  method: string,
  path: string,
  context: ClassifyContext = {},
): RateLimitClass | null {
  if (path === '/auth/login') return 'login';

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // The one read that is limited: an anonymous request, to one of the eight
    // allow-listed demo paths, while the demo window is open (P19).
    //
    // All three conditions matter. Anonymous, because a signed-in operator's
    // dashboard must keep the unlimited reads it has always had. Allow-listed,
    // because this must never become "GET is limited" and thereby suggest "GET
    // is public". And only while the window is open, because with it shut these
    // requests are refused by the gate anyway, and limiting them would turn the
    // 401 an existing deployment returns today into a 429.
    //
    // FAIL-CLOSED, VIA THE SAME VALUE THE GATE READS
    //
    // `publicReadsEnabled` is the same config field the gate uses, and that
    // field is false for anything that is not the literal string 'true'. So a
    // malformed or missing configuration cannot reach the dangerous state:
    // there is no way to serve these reads publicly while failing to recognise
    // them here, because one boolean decides both.
    if (context.publicReadsEnabled === true && context.authenticated !== true) {
      if (isPublicDemoRead(method, path)) return 'publicRead';
    }

    // Everything else stays as it was: reads are cheap, and limiting them would
    // make a busy dashboard look like an attack.
    return null;
  }

  if (EXPENSIVE_PATHS.some((pattern) => pattern.test(path))) return 'expensive';
  return 'mutation';
}

/**
 * The bucket key for a request.
 *
 * Session first, remote address second, and nothing else ever. Returning the
 * session's *token hash* rather than the operator name matters: with one
 * operator, keying on the name would put every session in one bucket, so a
 * second sign-in would inherit the first one's exhausted budget.
 */
export function keyFor(req: Request): string {
  if (req.session) return `session:${req.session.tokenHash}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}

export type RateLimitDeps = {
  limiter?: FixedWindowLimiter;
  clock?: Clock;
  limits?: Record<RateLimitClass, RateLimitRule>;
  /**
   * Whether the public demo window is open (P19).
   *
   * Passed in rather than read from config here, so this module stays a pure
   * function of its inputs and a test can drive both states without touching
   * the environment. Defaults false, matching the config default.
   */
  publicReadsEnabled?: boolean;
};

export function rateLimit(deps: RateLimitDeps = {}) {
  const limiter = deps.limiter ?? new FixedWindowLimiter(deps.clock);
  const limits = deps.limits ?? RATE_LIMITS;
  const publicReadsEnabled = deps.publicReadsEnabled === true;
  let sinceLastPrune = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    // `attachSession` runs before this middleware, so `req.session` is already
    // resolved and an operator is never mistaken for an anonymous visitor.
    const rateClass = classify(req.method, req.path, {
      publicReadsEnabled,
      authenticated: req.session !== undefined,
    });
    if (rateClass === null) {
      next();
      return;
    }

    // Opportunistic housekeeping, cheap and amortised. No background worker.
    if (++sinceLastPrune >= 500) {
      sinceLastPrune = 0;
      limiter.prune();
    }

    const decision = limiter.check(`${rateClass}:${keyFor(req)}`, limits[rateClass]);
    res.setHeader('X-RateLimit-Limit', String(limits[rateClass].limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      // No key, no identity, no path detail in the message — a refusal should
      // not describe the bucket it came from.
      next(
        new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.', {
          details: { retryAfterSeconds: decision.retryAfterSeconds },
        }),
      );
      return;
    }

    next();
  };
}
