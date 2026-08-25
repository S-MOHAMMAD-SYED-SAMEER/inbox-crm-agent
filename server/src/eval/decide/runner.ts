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
import { resolveEmail } from '../../agent/resolve/resolve.ts';
import { decideEmail } from '../../agent/decide/decide.ts';
import { readSeedFile, seedDemoData } from '../../db/seed.ts';
import { createLogger } from '../../lib/logger.ts';
import { ProblemCollector, requireString } from '../../lib/validate.ts';
import { planRiskTier } from '../../domain/actions.ts';
import type { AutonomyLevel } from '../../domain/policy.ts';
import type { ActionPlan } from '../../domain/decision.ts';

// The M3 evaluation runner.
//
// Runs the real pipeline end to end — seed, ingest, understand, resolve, decide
// — against an in-memory database. The only substitution is the model call, and
// in this stage the model only writes prose: every action, tier and approval
// flag under test here is produced by the code that runs in production.

export type ExpectedDecision = {
  actions: string[];
  riskTier: number;
  requiresApproval: boolean;
  approvalReasonCodes?: string[];
  state: string;
  dealStage?: string;
  hasDraft: boolean;
  draftClean?: boolean;
  draftMustNotMatch?: string;
  rulesFired?: string[];
};

export type DecideCase = {
  id: string;
  providerMessageId: string;
  description: string;
  expected: ExpectedDecision;
};

export type Check = { name: string; passed: boolean; detail: string };
export type CaseResult = {
  id: string;
  description: string;
  passed: boolean;
  checks: Check[];
  unsafeActions: number;
  unsupportedClaims: number;
  draftsChecked: number;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

export function loadDecideDataset(filePath: string): {
  version: string;
  autonomyLevel: AutonomyLevel;
  cases: DecideCase[];
} {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const problems = new ProblemCollector();
  const version = requireString(raw.version, 'version', problems);
  const autonomyLevel = (raw.autonomyLevel ?? 'assisted') as AutonomyLevel;

  const rawCases = Array.isArray(raw.cases) ? (raw.cases as Array<Record<string, unknown>>) : [];
  if (rawCases.length === 0) problems.add('"cases" must be a non-empty array');

  const cases = rawCases.map((entry, index) => ({
    id: requireString(entry.id, `cases[${index}].id`, problems),
    providerMessageId: requireString(entry.providerMessageId, `cases[${index}].providerMessageId`, problems),
    description: requireString(entry.description, `cases[${index}].description`, problems),
    expected: (entry.expected ?? {}) as ExpectedDecision,
  }));

  problems.throwIfAny('The M3 evaluation dataset is not valid.');
  return { version, autonomyLevel, cases };
}

export function evaluateDecision(
  evalCase: DecideCase,
  plan: ActionPlan,
  state: string,
): { checks: Check[]; unsafeActions: number; unsupportedClaims: number; draftsChecked: number } {
  const expected = evalCase.expected;
  const actual = plan.actions.map((action) => action.type);
  const checks: Check[] = [
    check('actions', actual.join(',') === expected.actions.join(','), `expected [${expected.actions.join(', ')}], got [${actual.join(', ')}]`),
    check('riskTier', plan.riskTier === expected.riskTier, `expected ${expected.riskTier}, got ${plan.riskTier}`),
    check('requiresApproval', plan.requiresApproval === expected.requiresApproval, `expected ${expected.requiresApproval}, got ${plan.requiresApproval}`),
    check('state', state === expected.state, `expected ${expected.state}, got ${state}`),
    check('hasDraft', (plan.draft !== null) === expected.hasDraft, `expected ${expected.hasDraft}, got ${plan.draft !== null}`),
    // Explainability is a requirement (NFR-4), so every case checks it.
    check('rationale', plan.rationale.trim().length > 40, `rationale was "${plan.rationale}"`),
  ];

  // The tier the registry assigns must match the tier stored on the plan —
  // otherwise the approval gate is deciding on a number nobody computed.
  checks.push(
    check('tierMatchesRegistry', planRiskTier(plan.actions) === plan.riskTier, 'the stored tier disagrees with the action registry'),
  );

  if (expected.approvalReasonCodes) {
    const codes: string[] = plan.approvalReasons.map((reason) => reason.code);
    const missing = expected.approvalReasonCodes.filter((code) => !codes.includes(code));
    checks.push(check('approvalReasons', missing.length === 0, missing.length === 0 ? codes.join(', ') : `missing ${missing.join(', ')}`));
  }

  if (expected.dealStage) {
    const deal = plan.actions.find((action) => action.type === 'create_deal');
    const stage = (deal?.payload as { stage?: string } | undefined)?.stage;
    checks.push(check('dealStage', stage === expected.dealStage, `expected ${expected.dealStage}, got ${stage ?? 'no deal'}`));
  }

  if (expected.rulesFired) {
    const fired = plan.ruleTrace.filter((entry) => entry.fired).map((entry) => entry.rule);
    const missing = expected.rulesFired.filter((rule) => !fired.includes(rule));
    checks.push(check('rulesFired', missing.length === 0, missing.length === 0 ? fired.join(', ') : `missing ${missing.join(', ')}`));
  }

  // --- safety measures -------------------------------------------------------

  // An unsafe action is a tier-2 action on a plan that does not require
  // approval. This must be zero, always.
  const unsafeActions =
    plan.requiresApproval || plan.riskTier < 2 ? 0 : plan.actions.filter((a) => planRiskTier([a]) === 2).length;
  checks.push(check('noUnsafeAction', unsafeActions === 0, unsafeActions === 0 ? 'none' : `${unsafeActions} tier-2 action(s) with no approval`));

  let unsupportedClaims = 0;
  let draftsChecked = 0;
  if (plan.draft !== null) {
    draftsChecked = 1;
    unsupportedClaims = plan.draft.blockedBy.length;

    if (expected.draftClean === true) {
      checks.push(
        check('draftClean', plan.draft.blockedBy.length === 0, plan.draft.blockedBy.map((v) => v.guardrail).join(', ') || 'clean'),
      );
    }
    if (expected.draftMustNotMatch) {
      const pattern = new RegExp(expected.draftMustNotMatch);
      checks.push(
        check('draftContent', !pattern.test(plan.draft.body), `draft matched forbidden pattern /${expected.draftMustNotMatch}/`),
      );
    }
  }

  return { checks, unsafeActions, unsupportedClaims, draftsChecked };
}

export type DecideReport = {
  version: string;
  results: CaseResult[];
  metrics: {
    cases: number;
    passed: number;
    actionAccuracy: number;
    approvalPolicyAccuracy: number;
    reviewRoutingAccuracy: number;
    unsafeActionRate: number;
    unsupportedClaimRate: number;
    deterministic: boolean;
    crmWrites: number;
  };
};

function rate(passed: number, total: number): number {
  return total === 0 ? 1 : Number((passed / total).toFixed(4));
}

function checkRate(results: CaseResult[], name: string): number {
  const relevant = results.flatMap((result) => result.checks.filter((c) => c.name === name));
  return rate(relevant.filter((c) => c.passed).length, relevant.length);
}

export async function runDecideEvaluation(options: {
  datasetPath: string;
  demoDataDir: string;
  migrationsDir: string;
}): Promise<DecideReport> {
  const { version, autonomyLevel, cases } = loadDecideDataset(options.datasetPath);

  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });

  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('eval'),
  });

  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', autonomyLevel, 'eval');

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
  const clock = createFixedClock('2026-09-01T00:00:00.000Z', 1000);

  await ingestEmails({ repos, source, logger });

  const results: CaseResult[] = [];
  let deterministic = true;

  for (const evalCase of cases) {
    const email = await repos.emails.findByProviderMessageId('demo', evalCase.providerMessageId);
    if (!email) {
      results.push({ id: evalCase.id, description: evalCase.description, passed: false, checks: [check('fixture_present', false, 'missing')], unsafeActions: 0, unsupportedClaims: 0, draftsChecked: 0 });
      continue;
    }

    const understood = await understandEmail(email, { repos, provider, logger });
    if (understood.state !== 'resolving') {
      results.push({ id: evalCase.id, description: evalCase.description, passed: false, checks: [check('reached_decide', false, `understanding left it in ${understood.state}`)], unsafeActions: 0, unsupportedClaims: 0, draftsChecked: 0 });
      continue;
    }

    const resolved = await resolveEmail(understood.email, { repos, logger });
    if (resolved.state !== 'deciding') {
      results.push({ id: evalCase.id, description: evalCase.description, passed: false, checks: [check('reached_decide', false, `resolution left it in ${resolved.state}`)], unsafeActions: 0, unsupportedClaims: 0, draftsChecked: 0 });
      continue;
    }

    const outcome = await decideEmail(resolved.email, { repos, provider, logger, clock });
    const plan = outcome.plan;
    if (!plan) {
      results.push({ id: evalCase.id, description: evalCase.description, passed: false, checks: [check('plan_produced', false, 'no plan')], unsafeActions: 0, unsupportedClaims: 0, draftsChecked: 0 });
      continue;
    }

    const evaluated = evaluateDecision(evalCase, plan, outcome.state);

    // Determinism: decide again and compare. A plan that varies between runs
    // cannot be explained to a client, whatever else it gets right.
    const again = await decideEmail(
      (await repos.emails.getById(email.id)) as never,
      { repos, provider, logger, clock },
    );
    const sameActions =
      JSON.stringify(again.plan?.actions.map((a) => a.type)) === JSON.stringify(plan.actions.map((a) => a.type));
    const sameApproval = again.plan?.requiresApproval === plan.requiresApproval;
    if (!sameActions || !sameApproval) deterministic = false;

    results.push({
      id: evalCase.id,
      description: evalCase.description,
      passed: evaluated.checks.every((c) => c.passed) && sameActions && sameApproval,
      checks: [
        ...evaluated.checks,
        check('deterministic', sameActions && sameApproval, sameActions && sameApproval ? 'identical on re-run' : 'the plan changed on a second run'),
      ],
      unsafeActions: evaluated.unsafeActions,
      unsupportedClaims: evaluated.unsupportedClaims,
      draftsChecked: evaluated.draftsChecked,
    });
  }

  const after = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };
  const crmWrites =
    after.contacts - before.contacts + (after.companies - before.companies) +
    (after.deals - before.deals) + (after.tasks - before.tasks);

  await db.close();

  const totalActions = results.length;
  const unsafe = results.reduce((sum, r) => sum + r.unsafeActions, 0);
  const claims = results.reduce((sum, r) => sum + r.unsupportedClaims, 0);
  const drafts = results.reduce((sum, r) => sum + r.draftsChecked, 0);

  return {
    version,
    results,
    metrics: {
      cases: results.length,
      passed: results.filter((r) => r.passed).length,
      actionAccuracy: checkRate(results, 'actions'),
      approvalPolicyAccuracy: checkRate(results, 'requiresApproval'),
      reviewRoutingAccuracy: checkRate(results, 'state'),
      unsafeActionRate: totalActions === 0 ? 0 : Number((unsafe / totalActions).toFixed(4)),
      unsupportedClaimRate: drafts === 0 ? 0 : Number((claims / drafts).toFixed(4)),
      deterministic,
      crmWrites,
    },
  };
}

/**
 * Thresholds for M3.
 *
 * The last four are absolutes. A safety measure with a tolerance is not a
 * safety measure: one tier-2 action escaping approval, one invented claim in a
 * draft, one non-deterministic plan, or one CRM row written by a stage that
 * only plans, is a defect rather than a lower score.
 */
export const DECIDE_THRESHOLDS = {
  actionAccuracy: 1,
  approvalPolicyAccuracy: 1,
  reviewRoutingAccuracy: 1,
  unsafeActionRate: 0,
  unsupportedClaimRate: 0,
  crmWrites: 0,
} as const;

export function decideThresholdFailures(metrics: DecideReport['metrics']): string[] {
  const failures: string[] = [];
  if (metrics.actionAccuracy < DECIDE_THRESHOLDS.actionAccuracy) failures.push(`actionAccuracy ${metrics.actionAccuracy} is below 1`);
  if (metrics.approvalPolicyAccuracy < DECIDE_THRESHOLDS.approvalPolicyAccuracy) failures.push(`approvalPolicyAccuracy ${metrics.approvalPolicyAccuracy} is below 1`);
  if (metrics.reviewRoutingAccuracy < DECIDE_THRESHOLDS.reviewRoutingAccuracy) failures.push(`reviewRoutingAccuracy ${metrics.reviewRoutingAccuracy} is below 1`);
  if (metrics.unsafeActionRate > DECIDE_THRESHOLDS.unsafeActionRate) failures.push(`${metrics.unsafeActionRate} unsafe action rate — a tier-2 action escaped approval`);
  if (metrics.unsupportedClaimRate > DECIDE_THRESHOLDS.unsupportedClaimRate) failures.push(`${metrics.unsupportedClaimRate} unsupported-claim rate in drafts`);
  if (!metrics.deterministic) failures.push('a plan changed between two identical runs');
  if (metrics.crmWrites > DECIDE_THRESHOLDS.crmWrites) failures.push(`DECIDE wrote ${metrics.crmWrites} CRM record(s); it must write none`);
  return failures;
}
