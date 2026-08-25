import { configSummary, type AppConfig, config as defaultConfig } from '../config/env.ts';
import { appliedMigrations } from '../db/migrate.ts';
import type { Database } from '../db/types.ts';

// Health handler.
//
// The handler is a plain function returning `{ status, body }`, and the Express
// route is a three-line wrapper around it. That is Project 1's shape
// (`handleChat` next to `router.post('/chat')`) and the reason is testing: this
// can be exercised with an in-memory database and no HTTP server, no port, and
// no supertest dependency.
//
// What it may report is constrained by FR-46: whether each dependency is
// configured, never *how*. No key, no fragment of a key, no connection string,
// and no host name. A health endpoint is usually the least-protected route in a
// system, so it is the wrong place to be generous with detail.

export type HealthDeps = {
  db?: Database;
  config?: AppConfig;
};

export type HealthBody = {
  status: 'ok' | 'degraded';
  database: { driver: string; reachable: boolean; migrationsApplied: number };
  adapters: Record<string, string | boolean | number>;
  version: string;
};

export async function handleHealth(deps: HealthDeps = {}): Promise<{ status: number; body: HealthBody }> {
  const cfg = deps.config ?? defaultConfig;

  let reachable = false;
  let migrationsApplied = 0;

  if (deps.db) {
    try {
      await deps.db.query('SELECT 1 AS ok');
      reachable = true;
      migrationsApplied = (await appliedMigrations(deps.db)).length;
    } catch {
      // Deliberately swallowed. The health endpoint's job is to report that
      // the database is unreachable, not to explain the driver's error to
      // whoever asked — that detail is for the log.
      reachable = false;
    }
  }

  const body: HealthBody = {
    status: reachable ? 'ok' : 'degraded',
    database: { driver: cfg.dbDriver, reachable, migrationsApplied },
    adapters: configSummary(cfg),
    // A product version, not a milestone label. Build names like "M4-B" are
    // internal vocabulary; this value is rendered by an operator surface and
    // must never read as a pre-release marker to whoever is looking at it.
    version: '1.0.0',
  };

  // 200 even when degraded: the service is up and answering, which is what a
  // liveness probe asks. `status: "degraded"` in the body is what a readiness
  // check and the Settings screen read.
  return { status: 200, body };
}
