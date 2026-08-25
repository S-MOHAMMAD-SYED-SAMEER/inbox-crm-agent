import path from 'node:path';
import { config, type AppConfig } from '../../config/env.ts';
import { createDemoEmailSource } from './demo.ts';
import type { EmailSource } from './types.ts';

export type { EmailSource, OutboundEmail, FetchResult } from './types.ts';
export { createDemoEmailSource, parseDemoFixtures, type DemoEmailFixture } from './demo.ts';

/**
 * Selects the email source for the current configuration.
 *
 * `gmail` is not implemented and is not reachable: config/env.ts already falls
 * `EMAIL_SOURCE=gmail` back to `demo` with a startup warning, so this switch
 * has one live branch. Gmail arrives as a new file implementing the same
 * interface (§23) — no caller changes.
 */
export function createEmailSource(cfg: AppConfig = config): EmailSource {
  return createDemoEmailSource({ filePath: path.join(cfg.demoDataDir, 'emails.json') });
}
