import fs from 'node:fs';
import path from 'node:path';
import type { MockLlmProvider } from './mock.ts';

// Binds the demo dataset's canned model responses to the mock provider.
//
// Each fixture in `data/demo/emails.json` carries a `mockUnderstanding`: the
// exact tool input the model would have produced for that email. The mock
// provider looks responses up by `metadata.fixtureId`, and the UNDERSTAND stage
// sets that to the email's `providerMessageId` — so a fixture's canned response
// follows it through the real pipeline without any test-only branch existing in
// the pipeline itself.
//
// That last point is the one that matters. Nothing in `understand.ts` knows
// whether it is talking to a fixture or to Claude; the only difference between
// a mock run and a real run is which object implements `LlmProvider`. So a
// deterministic run exercises the genuine validation, provenance, injection,
// persistence and state-transition code, rather than a simplified version of it.

export type FixtureFile = Array<{
  providerMessageId?: unknown;
  mockUnderstanding?: unknown;
  mockDraft?: unknown;
}>;

/**
 * Reads canned responses keyed by the fixture id the pipeline will ask for.
 *
 * UNDERSTAND asks for `<providerMessageId>`; DECIDE asks for
 * `<providerMessageId>:draft`. Both keys are built here so neither stage needs
 * to know that fixtures exist.
 */
export function readMockUnderstandings(dataDir: string): Map<string, Record<string, unknown>> {
  const filePath = path.join(dataDir, 'emails.json');
  if (!fs.existsSync(filePath)) return new Map();

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) return new Map();

  const out = new Map<string, Record<string, unknown>>();
  for (const entry of parsed as FixtureFile) {
    const id = entry.providerMessageId;
    const understanding = entry.mockUnderstanding;
    if (typeof id === 'string' && understanding !== undefined && understanding !== null) {
      out.set(id, understanding as Record<string, unknown>);
    }
    const draft = entry.mockDraft;
    if (typeof id === 'string' && draft !== undefined && draft !== null) {
      out.set(`${id}:draft`, draft as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Registers every canned response from the demo dataset.
 *
 * Fixtures without a `mockUnderstanding` are simply not registered — asking the
 * mock about them then raises `MockResponseNotFoundError` rather than producing
 * an invented reading, which is the correct outcome: a fixture nobody wrote an
 * answer for has no answer.
 */
export function registerDemoFixtures(provider: MockLlmProvider, dataDir: string): number {
  const understandings = readMockUnderstandings(dataDir);
  for (const [fixtureId, toolInput] of understandings) {
    provider.register(fixtureId, { toolInput, model: 'mock' });
  }
  return understandings.size;
}
