import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHealthRouter } from './routes/health.ts';
import { createEmailRouter } from './routes/emails.ts';
import { createCrmRouter } from './routes/crm.ts';
import { createAuthRouter } from './routes/auth.ts';
import { attachSession, requireSession } from './auth/middleware.ts';
import { requireCsrf } from './auth/csrf.ts';
import { cors } from './http/cors.ts';
import { rateLimit } from './http/rateLimit.ts';
import { createRepositories } from './db/repositories/index.ts';
import { createEmailSource } from './adapters/email/index.ts';
import { createLlmProvider, createMockLlmProvider, registerDemoFixtures } from './adapters/llm/index.ts';
import { config as defaultConfig, type AppConfig } from './config/env.ts';
import type { LlmProvider } from './adapters/llm/types.ts';
import type { EmailSource } from './adapters/email/types.ts';
import { toErrorEnvelope } from './lib/errors.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import type { Database } from './db/types.ts';

// Express application assembly, separated from the server bootstrap so a test
// can build the app without binding a port.

export type AppDeps = {
  db: Database;
  /** Injectable so a test can drive the limiter with a fixed clock (M5-C). */
  rateLimiter?: ReturnType<typeof rateLimit>;
  logger?: Logger;
  config?: AppConfig;
  /** Injectable so tests can supply a stub provider and source. */
  provider?: LlmProvider;
  source?: EmailSource;
};

// 256 KB (spec §11). Large enough for any plausible email payload, small enough
// that a request cannot be used to exhaust memory. The email body gets its own,
// tighter cap at ingestion in M1.
const MAX_BODY_BYTES = 256 * 1024;

export function createApp({
  db,
  logger = createLogger('http'),
  config = defaultConfig,
  provider,
  source,
  rateLimiter = rateLimit(),
}: AppDeps): Express {
  const app = express();

  const repos = createRepositories(db);
  const emailSource = source ?? createEmailSource(config);

  // With the mock provider, the demo dataset's canned responses are registered
  // up front. That is what makes a local run deterministic end to end: the same
  // pipeline, the same validation, the same persistence — only the model call
  // is a fixture. Real providers are constructed as configured and never
  // pre-loaded with anything.
  const llmProvider =
    provider ??
    (config.llmProvider === 'mock'
      ? (() => {
          const mock = createMockLlmProvider();
          const registered = registerDemoFixtures(mock, config.demoDataDir);
          logger.info(`Mock provider ready with ${registered} canned response(s).`);
          return mock;
        })()
      : createLlmProvider(config));

  app.disable('x-powered-by');

  // CORS first, so a preflight is answered before anything reads a body, and so
  // a disallowed cross-origin write is refused before it can reach a route.
  app.use('/api', cors({ allowedOrigins: config.corsAllowedOrigins }));

  app.use(express.json({ limit: MAX_BODY_BYTES }));

  // Malformed JSON otherwise falls through to Express's default HTML error
  // page, which carries a full server-side stack trace — file paths and all.
  // Project 1 hit exactly this and handled it the same way: respond like every
  // other input-validation failure in the API does, with a clean JSON envelope.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const candidate = err as { type?: string } | null;
    if (candidate?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON.' } });
      return;
    }
    if (candidate?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is too large.' } });
      return;
    }
    next(err);
  });

  // --- authentication (M5-A) -------------------------------------------------
  //
  // The order below is the security boundary, so it is worth reading as one:
  //
  //   1. health      — liveness, before anything. A monitor must not need a
  //                    password to learn the service is up, and the endpoint
  //                    reports capabilities, never secrets.
  //   2. attachSession — resolves a session if one is presented. Never rejects.
  //   3. auth routes — login/logout/session. The only endpoints reachable
  //                    without a session, which is why they sit above the gate.
  //   4. requireSession — the gate. Everything past it is authenticated.
  //   5. email routes — every mutation in the product.
  //
  // Anything added after step 4 is protected by default. That is deliberate:
  // the failure mode of a deny-list is a route someone forgot to add to it.
  app.use('/api', createHealthRouter(db, config));

  app.use('/api', attachSession({ repos }));

  // Rate limiting after `attachSession`, so an authenticated caller is keyed by
  // their session rather than sharing an IP bucket with everyone behind the same
  // NAT — and so an unauthenticated login attempt still gets an IP bucket.
  // Health sits above this and is deliberately never limited: a monitor asking
  // "are you alive?" must not be the thing that gets throttled.
  app.use('/api', rateLimiter);

  // CSRF sits between "who is this?" and "may they?". It runs before the auth
  // routes so that logout is protected, and it ignores requests with no session
  // — `requireSession` below is what refuses those, and two layers answering the
  // same question with different codes would make 401 and 403 interchangeable.
  app.use('/api', requireCsrf());

  app.use('/api', createAuthRouter({ repos, config, logger }));

  app.use('/api', requireSession());
  app.use('/api', createEmailRouter({ repos, source: emailSource, provider: llmProvider, logger }));

  // Read-only CRM projections (M6-C). Below the gate, so authenticated by
  // default; GET only, so they add no way to write.
  app.use('/api', createCrmRouter(repos));

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.' } });
  });

  // Terminal error handler. Everything reaching here is converted by one
  // function (lib/errors.ts) so a response can never carry an internal message
  // by accident: the safe envelope goes to the client, the real detail goes to
  // the log.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body, internal } = toErrorEnvelope(err);
    logger.error('Unhandled request error', { status, code: body.error.code, internal });
    res.status(status).json(body);
  });

  return app;
}
