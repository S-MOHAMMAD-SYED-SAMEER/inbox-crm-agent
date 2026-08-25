import { Router } from 'express';
import { handleHealth } from '../handlers/health.ts';
import type { AppConfig } from '../config/env.ts';
import type { Database } from '../db/types.ts';

/**
 * Routes are thin by policy: parse the request, call the handler, send what it
 * returns. No business logic lives in a route, so no business logic requires an
 * HTTP server to test.
 */
export function createHealthRouter(db: Database, config?: AppConfig): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    // The *running app's* config, not the process-global default.
    //
    // `handleHealth` has always accepted a config and fallen back to the module
    // singleton when it got none — and this router never passed one, so health
    // described the process rather than the app mounted on it. With an app
    // built from an explicit config (every test, and the demo walkthrough) the
    // two disagree: it reported `authConfigured: false` while sign-in worked.
    // A status surface that contradicts the system it is reporting on is worse
    // than no status surface.
    const result = await handleHealth(config ? { db, config } : { db });
    res.status(result.status).json(result.body);
  });

  return router;
}
