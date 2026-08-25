import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.ts';

// CORS, written out rather than installed (M5-B).
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
// A browser sends no `Origin` on a same-origin GET, and the front end is served
// from the same origin as the API. So the default configuration — an empty
// allow-list — is not "CORS is broken", it is "there are no cross-origin
// clients", which is the correct posture until there are.
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
  if (!origin) return true; // same-origin, or a non-browser client
  return allowed.includes(origin);
}

export function cors({ allowedOrigins }: CorsOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const permitted = isAllowed(origin, allowedOrigins);

    if (origin && permitted) {
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
