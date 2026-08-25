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
import { resolveEmail, enrichCandidateLabels } from '../../agent/resolve/resolve.ts';
import { readSeedFile, seedDemoData } from '../../db/seed.ts';
import { createLogger } from '../../lib/logger.ts';
import { ProblemCollector, requireString } from '../../lib/validate.ts';
import type { EntityResolution } from '../../domain/resolution.ts';

// The M2 evaluation runner.
//
// Runs the real pipeline — real seeding, real ingestion, real understanding,
// real resolution — against an in-memory database. Only the model call is
// replaced, and resolution does not use one at all, so the resolver under test
// here is exactly the resolver that runs in production.
//
// Deterministic by construction: fixed clock, sequential ids, seeded CRM. The
// same dataset produces the same candidates and the same scores on every run,
// which is the property the whole "explainable to a client" claim rests on.

export type ExpectedSide = {
  verdict: string;
  outcome: string;
  candidateCount?: number;
  candidateLabels?: string[];
  selectedLabel?: string;
  topMethod?: string;
  topScore?: number;
  noSelection?: boolean;
};

export type ResolveCase = {
  id: string;
  providerMessageId: string;
  description: string;
  expected: {
    state: string;
    reviewReason: string | null;
    contact: ExpectedSide;
    company: ExpectedSide;
  };
};

export type Check = { name: string; passed: boolean; detail: string };
export type CaseResult = { id: string; description: string; passed: boolean; checks: Check[] };

export function loadResolveDataset(filePath: string): { version: string; cases: ResolveCase[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const problems = new ProblemCollector();
  const version = requireString(raw.version, 'version', problems);
  const rawCases = Array.isArray(raw.cases) ? (raw.cases as Array<Record<string, unknown>>) : [];
  if (rawCases.length === 0) problems.add('"cases" must be a non-empty array');

  const cases = rawCases.map((entry, index) => {
    const where = `cases[${index}]`;
    const expected = (entry.expected ?? {}) as Record<string, unknown>;
    return {
      id: requireString(entry.id, `${where}.id`, problems),
      providerMessageId: requireString(entry.providerMessageId, `${where}.providerMessageId`, problems),
      description: requireString(entry.description, `${where}.description`, problems),
      expected: {
        state: requireString(expected.state, `${where}.expected.state`, problems),
        reviewReason: (expected.reviewReason ?? null) as string | null,
        contact: (expected.contact ?? {}) as ExpectedSide,
        company: (expected.company ?? {}) as ExpectedSide,
      },
    };
  });

  problems.throwIfAny('The M2 evaluation dataset is not valid.');
  return { version, cases };
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

export function evaluateSide(side: string, expected: ExpectedSide, actual: EntityResolution): Check[] {
  const checks: Check[] = [
    check(`${side}:verdict`, actual.verdict === expected.verdict, `expected ${expected.verdict}, got ${actual.verdict}`),
    check(`${side}:outcome`, actual.outcome === expected.outcome, `expected ${expected.outcome}, got ${actual.outcome}`),
  ];

  if (expected.candidateCount !== undefined) {
    checks.push(
      check(
        `${side}:candidateCount`,
        actual.candidates.length === expected.candidateCount,
        `expected ${expected.candidateCount}, got ${actual.candidates.length}`,
      ),
    );
  }

  if (expected.candidateLabels !== undefined) {
    const labels = actual.candidates.map((candidate) => candidate.label).sort();
    const wanted = [...expected.candidateLabels].sort();
    checks.push(
      check(
        `${side}:candidateLabels`,
        labels.join('|') === wanted.join('|'),
        `expected [${wanted.join(', ')}], got [${labels.join(', ')}]`,
      ),
    );
  }

  if (expected.selectedLabel !== undefined) {
    const selected = actual.candidates.find((candidate) => candidate.entityId === actual.selectedEntityId);
    checks.push(
      check(
        `${side}:selected`,
        selected?.label === expected.selectedLabel,
        `expected "${expected.selectedLabel}", got "${selected?.label ?? 'nothing selected'}"`,
      ),
    );
  }

  if (expected.noSelection === true) {
    // The property that matters most on a conflict: nothing was linked.
    checks.push(
      check(
        `${side}:noSelection`,
        actual.selectedEntityId === null,
        `a conflict must link nothing, but ${actual.selectedEntityId ?? 'null'} was selected`,
      ),
    );
  }

  if (expected.topMethod !== undefined) {
    checks.push(
      check(
        `${side}:topMethod`,
        actual.candidates[0]?.method === expected.topMethod,
        `expected ${expected.topMethod}, got ${actual.candidates[0]?.method ?? 'none'}`,
      ),
    );
  }

  if (expected.topScore !== undefined) {
    checks.push(
      check(
        `${side}:topScore`,
        actual.candidates[0]?.score === expected.topScore,
        `expected ${expected.topScore}, got ${actual.candidates[0]?.score ?? 'none'}`,
      ),
    );
  }

  // Explainability is a requirement, not a nicety (NFR-4): a verdict nobody can
  // read is not an explanation, so every case checks it.
  checks.push(
    check(`${side}:reason`, actual.reason.trim().length > 20, `reason was "${actual.reason}"`),
  );

  return checks;
}

export type ResolveReport = {
  version: string;
  results: CaseResult[];
  metrics: {
    cases: number;
    passed: number;
    verdictAccuracy: number;
    conflictsDetected: number;
    conflictsLinked: number;
    crmWrites: number;
  };
};

export async function runResolveEvaluation(options: {
  datasetPath: string;
  demoDataDir: string;
  migrationsDir: string;
}): Promise<ResolveReport> {
  const { version, cases } = loadResolveDataset(options.datasetPath);

  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('eval'),
  });

  await seedDemoData(repos, readSeedFile(options.demoDataDir));

  const before = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };

  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });
  const provider = createMockLlmProvider();
  registerDemoFixtures(provider, options.demoDataDir);
  const logger = createLogger('eval', { level: 'error' });

  await ingestEmails({ repos, source, logger });

  const results: CaseResult[] = [];
  let conflictsDetected = 0;
  let conflictsLinked = 0;

  for (const evalCase of cases) {
    const email = await repos.emails.findByProviderMessageId('demo', evalCase.providerMessageId);
    if (!email) {
      results.push({
        id: evalCase.id,
        description: evalCase.description,
        passed: false,
        checks: [check('fixture_present', false, `no email ${evalCase.providerMessageId}`)],
      });
      continue;
    }

    const understood = await understandEmail(email, { repos, provider, logger });
    if (understood.state !== 'resolving') {
      results.push({
        id: evalCase.id,
        description: evalCase.description,
        passed: false,
        checks: [check('reached_resolution', false, `understanding left it in ${understood.state}`)],
      });
      continue;
    }

    const outcome = await resolveEmail(understood.email, { repos, logger });
    const contact = await enrichCandidateLabels(repos, outcome.contact);
    const company = await enrichCandidateLabels(repos, outcome.company);

    const checks: Check[] = [
      check('state', outcome.state === evalCase.expected.state, `expected ${evalCase.expected.state}, got ${outcome.state}`),
      check(
        'reviewReason',
        (outcome.reviewReason ?? null) === evalCase.expected.reviewReason,
        `expected ${evalCase.expected.reviewReason ?? 'none'}, got ${outcome.reviewReason ?? 'none'}`,
      ),
      ...evaluateSide('contact', evalCase.expected.contact, contact),
      ...evaluateSide('company', evalCase.expected.company, company),
    ];

    for (const resolution of [contact, company]) {
      if (resolution.verdict === 'MATCH_CONFLICT') {
        conflictsDetected++;
        if (resolution.selectedEntityId !== null) conflictsLinked++;
      }
    }

    results.push({
      id: evalCase.id,
      description: evalCase.description,
      passed: checks.every((c) => c.passed),
      checks,
    });
  }

  // The safety property of this whole stage: resolution reads the CRM, and
  // never writes to it. Measured, not assumed.
  const after = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };
  const crmWrites =
    after.contacts - before.contacts +
    (after.companies - before.companies) +
    (after.deals - before.deals) +
    (after.tasks - before.tasks);

  await db.close();

  const verdictChecks = results.flatMap((result) => result.checks.filter((c) => c.name.endsWith(':verdict')));

  return {
    version,
    results,
    metrics: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      verdictAccuracy:
        verdictChecks.length === 0
          ? 1
          : Number((verdictChecks.filter((c) => c.passed).length / verdictChecks.length).toFixed(4)),
      conflictsDetected,
      conflictsLinked,
      crmWrites,
    },
  };
}

/**
 * Thresholds for M2.
 *
 * The last two are absolutes: a conflict that got linked anyway, or a CRM row
 * written by a read-only stage, is a defect rather than a lower score.
 */
export const RESOLVE_THRESHOLDS = {
  verdictAccuracy: 1,
  conflictsDetectedMinimum: 1,
  conflictsLinked: 0,
  crmWrites: 0,
} as const;

export function resolveThresholdFailures(metrics: ResolveReport['metrics']): string[] {
  const failures: string[] = [];
  if (metrics.verdictAccuracy < RESOLVE_THRESHOLDS.verdictAccuracy) {
    failures.push(`verdictAccuracy ${metrics.verdictAccuracy} is below ${RESOLVE_THRESHOLDS.verdictAccuracy}`);
  }
  if (metrics.conflictsDetected < RESOLVE_THRESHOLDS.conflictsDetectedMinimum) {
    failures.push('no conflict was detected — the E-04 case must produce one');
  }
  if (metrics.conflictsLinked > RESOLVE_THRESHOLDS.conflictsLinked) {
    failures.push(`${metrics.conflictsLinked} conflict(s) were linked despite being unresolved`);
  }
  if (metrics.crmWrites > RESOLVE_THRESHOLDS.crmWrites) {
    failures.push(`resolution wrote ${metrics.crmWrites} CRM record(s); it must write none`);
  }
  return failures;
}
