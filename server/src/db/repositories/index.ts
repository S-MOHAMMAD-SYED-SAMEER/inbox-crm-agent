import { systemClock, type Clock } from '../../lib/clock.ts';
import { newId as defaultNewId, type IdGenerator } from '../../lib/ids.ts';
import type { Database } from '../types.ts';
import {
  createActivityRepository,
  createCompanyRepository,
  createContactRepository,
  createDealRepository,
  createNoteRepository,
  createTaskRepository,
  type RepoDeps,
} from './crm.ts';
import { createEmailRepository } from './emails.ts';
import { createAnalysisRepository } from './analyses.ts';
import { createEntityMatchRepository } from './entityMatches.ts';
import { createDecisionRepository } from './decisions.ts';
import { createApprovalRepository } from './approvals.ts';
import { createExecutionRepository, createOutboxRepository } from './executions.ts';
import { createAuditRepository } from './audit.ts';
import { createSessionRepository } from './sessions.ts';
import { createSettingsRepository } from './settings.ts';

// One place that assembles every repository over one database, one clock, and
// one id generator.
//
// Handlers and services take a `Repositories` object rather than importing
// repositories individually. That is what makes a test able to swap the entire
// data layer — in-memory database, fixed clock, sequential ids — in a single
// line, and it is why no module in this codebase reaches for a database
// singleton.

export type Repositories = {
  db: Database;
  /**
   * Runs `fn` inside one transaction, with every repository rebound to it.
   *
   * `repos.db.transaction(...)` is NOT equivalent. Repositories close over the
   * database they were built with, so inside such a block their writes still go
   * through the root handle — which on SQLite happens to be the same connection
   * and therefore happens to be atomic, but on Postgres is a different pooled
   * client and therefore is not. Rebinding removes the difference between the
   * two drivers instead of relying on one of them being forgiving.
   */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
  companies: ReturnType<typeof createCompanyRepository>;
  contacts: ReturnType<typeof createContactRepository>;
  deals: ReturnType<typeof createDealRepository>;
  tasks: ReturnType<typeof createTaskRepository>;
  activities: ReturnType<typeof createActivityRepository>;
  notes: ReturnType<typeof createNoteRepository>;
  emails: ReturnType<typeof createEmailRepository>;
  analyses: ReturnType<typeof createAnalysisRepository>;
  entityMatches: ReturnType<typeof createEntityMatchRepository>;
  decisions: ReturnType<typeof createDecisionRepository>;
  approvals: ReturnType<typeof createApprovalRepository>;
  executions: ReturnType<typeof createExecutionRepository>;
  outbox: ReturnType<typeof createOutboxRepository>;
  audit: ReturnType<typeof createAuditRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
};

export function createRepositories(
  db: Database,
  options: { clock?: Clock; newId?: IdGenerator } = {},
): Repositories {
  const deps: RepoDeps = {
    db,
    clock: options.clock ?? systemClock,
    newId: options.newId ?? defaultNewId,
  };

  return {
    db,
    transaction: (fn) => db.transaction((tx) => fn(createRepositories(tx, deps))),
    companies: createCompanyRepository(deps),
    contacts: createContactRepository(deps),
    deals: createDealRepository(deps),
    tasks: createTaskRepository(deps),
    activities: createActivityRepository(deps),
    notes: createNoteRepository(deps),
    emails: createEmailRepository(deps),
    analyses: createAnalysisRepository(deps),
    entityMatches: createEntityMatchRepository(deps),
    decisions: createDecisionRepository(deps),
    approvals: createApprovalRepository(deps),
    executions: createExecutionRepository(deps),
    outbox: createOutboxRepository(deps),
    audit: createAuditRepository(deps),
    settings: createSettingsRepository(deps),
    sessions: createSessionRepository(deps),
  };
}

export type { RepoDeps, ListOptions } from './crm.ts';
export { DEFAULT_SETTINGS, type SettingsShape } from './settings.ts';
