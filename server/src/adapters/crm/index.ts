import { config, type AppConfig } from '../../config/env.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import { createLocalCrmReader } from './local.ts';
import type { CrmReader } from './types.ts';

export type {
  CrmReader,
  CrmWriter,
  CrmAdapter,
  TimelineItem,
  ActionResult,
  ExecutionContext,
} from './types.ts';
export { createLocalCrmReader } from './local.ts';

/**
 * Selects the CRM target for the current configuration.
 *
 * `hubspot` is unreachable: config/env.ts falls it back to `local` with a
 * startup warning. When it is built it implements the same interface and
 * answers `supportsAtomicity: false`, which the approval policy already knows
 * how to handle (§16 rule 7) — the constraint was designed for before the
 * integration exists.
 */
export function createCrmReader(repos: Repositories, _cfg: AppConfig = config): CrmReader {
  return createLocalCrmReader(repos);
}
