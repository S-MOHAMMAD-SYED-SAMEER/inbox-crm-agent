import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.ts';

// CORS, written out rather than installed.
//
// The `cors` package is ~200 lines of option handling for a policy this
// application states in one sentence: *the API answers its own front end and
// nothing else, unless an operator names an origin explicitly.*
//
// THE RULE THAT MATTERS
//
// `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials: true`
// are incompatible — browsers reject the pair — and any implementation that
// works around that by reflecting whatever `Origin` arrives has built a wildcard
// with extra steps. This one echoes an origin only after finding it in a
// configured allow-list, so the response can never name an origin nobody
// approved.
//
// SAME-ORIGIN REQUESTS ARE NOT CORS
//
// The front end is served from the same origin as the API, so the default
// configuration — an empty allow-list — means "there are no cross-origin
// clients", which is the correct posture until there are.
//
// A browser sends no `Origin` on a same-origin GET, but it DOES send one on a
// same-origin POST (and on any other non-GET fetch). An earlier version of this
// file treated every `Origin` as foreign unless listed, so with an empty
// allow-list the server refused its own dashboard's sign-in with a 403. The
// rule is now: an `Origin` that equals this server's own origin (the scheme the
// request arrived on plus its `Host`) is the server's own front end, not a
// cross-origin client, and passes with an empty allow-list. Any other `Origin`
// still needs to be in the allow-list.
//
// Why comparing against `Host` is safe: a page on another site cannot make a
// browser send an `Origin` of this server, and cannot change the `Host` the
// browser sends to it. A request that forges both is not a browser, and a
// non-browser client was never what this check protects against (it holds no
// session cookie it did not obtain itself, and the CSRF token still applies).
//
// CROSS-ORIGIN STATE CHANGES ARE REFUSED OUTRIGHT
//
// A disallowed `Origin` on a mutating request is rejected server-side rather
// than merely having the CORS headers withheld. Withholding headers stops the
// *browser* reading the response — the request still executed. For anything that
// writes, that is far too late.

export type CorsOptions = {
  /** Exact origins permitted to make credentialed requests. Empty = same-origin only. */
  allowedOrigins: readonly string[];
};

const ALLOWED_HEADERS = 'content-type, x-csrf-token';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

function isAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true; // a same-origin GET, or a non-browser client
  return allowed.includes(origin);
}

/**
 * The origin this request was made to: the scheme it arrived on and its `Host`.
 * `req.protocol` honours `trust proxy`, so behind a configured TLS-terminating
 * proxy this is the public https origin, and with no proxy configured a forged
 * `X-Forwarded-Proto` is ignored.
 */
export function ownOrigin(req: Request): string | undefined {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : undefined;
}

/** True when `origin` is exactly this server's own origin (case-insensitive scheme and host). */
export function isOwnOrigin(origin: string | undefined, own: string | undefined): boolean {
  return Boolean(origin && own && origin.toLowerCase() === own.toLowerCase());
}

export function cors({ allowedOrigins }: CorsOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    // The server's own front end is never a cross-origin client: it passes, and
    // needs no CORS headers (the browser does not apply CORS to it).
    const own = isOwnOrigin(origin, ownOrigin(req));
    const permitted = own || isAllowed(origin, allowedOrigins);

    if (origin && permitted && !own) {
      // Echoed only after an allow-list match, never reflected blindly.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      // The response varies by Origin, so a shared cache must not serve one
      // origin's response to another.
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (!permitted) {
        // No CORS headers: the browser refuses the preflight, and the real
        // request is never sent.
        res.status(403).end();
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    if (!permitted && req.method !== 'GET' && req.method !== 'HEAD') {
      // Server-side refusal. Withholding headers would let the write happen and
      // only stop the attacker reading the answer.
      next(
        new AppError('FORBIDDEN', 'This request came from an origin that is not allowed.', {
          details: { reason: 'origin_not_allowed' },
        }),
      );
      return;
    }

    next();
  };
}
