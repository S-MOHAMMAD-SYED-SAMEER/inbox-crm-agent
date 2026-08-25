import fs from 'node:fs';
import path from 'node:path';
import { createTestDatabase } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createRepositories } from '../../db/repositories/index.ts';
import { createFixedClock } from '../../lib/clock.ts';
import { createSequentialIds } from '../../lib/ids.ts';
import { createDemoEmailSource } from '../../adapters/email/demo.ts';
import { createMockLlmProvider, registerDemoFixtures } from '../../adapters/llm/index.ts';
import { ingestEmails } from '../../agent/ingest/ingest.ts';
import { understandEmail } from '../../agent/understand/understand.ts';
import { createLogger } from '../../lib/logger.ts';
import { aggregate, evaluateCase, type CaseResult, type EvalCase, type Metrics } from './metrics.ts';
import { ProblemCollector, requireOneOf, requireString } from '../../lib/validate.ts';
import { EMAIL_CATEGORIES, EMAIL_STATES, PRIORITIES, CONFIDENCE_BANDS } from '../../domain/email.ts';

// The M1 evaluation runner.
//
// It runs the **real pipeline** — real ingestion, real sanitisation, real
// validation, real provenance checking, real injection detection, real
// persistence, real state transitions — against an in-memory database. The only
// substitution is the model call itself, which replays the dataset's canned
// responses.
//
// That is the same arrangement Project 1's runner used, and the reason is that
// an eval which exercises a simplified copy of the pipeline measures the copy.
// Here, if provenance validation breaks, this suite fails; if the injection
// detector stops being authoritative over the model, this suite fails.
//
// Mock mode only. A real-provider mode belongs to M6 alongside the rest of §20,
// and would spend money that M1 has no reason to spend.

export type EvalReport = {
  version: string;
  results: CaseResult[];
  metrics: Metrics;
};

export function loadDataset(filePath: string): { version: string; cases: EvalCase[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const problems = new ProblemCollector();

  const version = requireString(raw.version, 'version', problems);
  const rawCases = Array.isArray(raw.cases) ? (raw.cases as Array<Record<string, unknown>>) : [];
  if (rawCases.length === 0) problems.add('"cases" must be a non-empty array');

  const seen = new Set<string>();
  const cases: EvalCase[] = rawCases.map((entry, index) => {
    const where = `cases[${index}]`;
    const id = requireString(entry.id, `${where}.id`, problems);
    if (seen.has(id)) problems.add(`${where}: duplicate id "${id}"`);
    seen.add(id);

    const expected = (entry.expected ?? {}) as Record<string, unknown>;
    requireOneOf(expected.category, `${where}.expected.category`, EMAIL_CATEGORIES, problems);
    requireOneOf(expected.priority, `${where}.expected.priority`, PRIORITIES, problems);
    requireOneOf(expected.confidenceBand, `${where}.expected.confidenceBand`, CONFIDENCE_BANDS, problems);
    requireOneOf(expected.state, `${where}.expected.state`, EMAIL_STATES, problems);

    return {
      id,
      providerMessageId: requireString(entry.providerMessageId, `${where}.providerMessageId`, problems),
      description: requireString(entry.description, `${where}.description`, problems),
      expected: {
        category: expected.category as string,
        priority: expected.priority as string,
        confidenceBand: expected.confidenceBand as string,
        state: expected.state as string,
        reviewReason: (expected.reviewReason ?? null) as string | null,
        mustExtract: (expected.mustExtract ?? {}) as Record<string, string>,
        mustBePresent: (expected.mustBePresent ?? []) as string[],
        mustBeNotProvided: (expected.mustBeNotProvided ?? []) as string[],
        questionAsked: expected.questionAsked === true,
        injectionSuspected: expected.injectionSuspected === true,
        ...(Array.isArray(expected.injectionRules) ? { injectionRules: expected.injectionRules as string[] } : {}),
        droppedFields: (expected.droppedFields ?? []) as string[],
      },
    };
  });

  problems.throwIfAny('The M1 evaluation dataset is not valid.');
  return { version, cases };
}

export async function runEvaluation(options: {
  datasetPath: string;
  demoDataDir: string;
  migrationsDir: string;
}): Promise<EvalReport> {
  const { version, cases } = loadDataset(options.datasetPath);

  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  // A fixed clock and sequential ids: the report must be identical on every run
  // so a diff between two runs means a behaviour change, not a timestamp.
  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('eval'),
  });

  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);

  const logger = createLogger('eval', { level: 'error' });
  await ingestEmails({ repos, source, logger });

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const email = await repos.emails.findByProviderMessageId('demo', evalCase.providerMessageId);
    if (!email) {
      results.push({
        id: evalCase.id,
        description: evalCase.description,
        passed: false,
        checks: [{ name: 'fixture_present', passed: false, detail: `no email ${evalCase.providerMessageId}` }],
        extraction: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
        hallucinations: 0,
        hallucinationOpportunities: 0,
      });
      continue;
    }

    const outcome = await understandEmail(email, { repos, provider, logger });
    results.push(evaluateCase(evalCase, outcome));
  }

  await db.close();
  return { version, results, metrics: aggregate(results) };
}
