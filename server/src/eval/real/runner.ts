import path from 'node:path';
import { createTestDatabase } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createRepositories } from '../../db/repositories/index.ts';
import { readSeedFile, seedDemoData } from '../../db/seed.ts';
import { createFixedClock } from '../../lib/clock.ts';
import { createSequentialIds } from '../../lib/ids.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { createDemoEmailSource } from '../../adapters/email/demo.ts';
import {
  LlmUnavailableError,
  summarizeUsage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type UsageSummary,
} from '../../adapters/llm/index.ts';
import { ingestEmails } from '../../agent/ingest/ingest.ts';
import { understandEmail } from '../../agent/understand/understand.ts';
import { resolveEmail } from '../../agent/resolve/resolve.ts';
import { decideEmail } from '../../agent/decide/decide.ts';
import {
  aggregate,
  evaluateCase,
  thresholdFailures,
  type CaseResult as UnderstandResult,
  type Metrics as UnderstandMetrics,
} from '../understand/metrics.ts';
import { loadDataset } from '../understand/runner.ts';
import {
  buildDecideMetrics,
  decideThresholdFailures,
  evaluateDecision,
  loadDecideDataset,
  type CaseResult as DecideResult,
  type DecideReport,
} from '../decide/runner.ts';
import { GOLD_LABEL, GOLD_PROVENANCE } from '../provenance.ts';

// The real-model evaluation runner.
//
// It runs the same pipeline as the mock evaluations (ingest, UNDERSTAND, RESOLVE, DECIDE,
// against an in-memory database and the seeded demo CRM) with a REAL provider in place of the
// scripted one, and scores it with the same functions, so a real number and a mock number
// mean the same thing.
//
// WHAT IT KEEPS. Every raw model reply (the tool argument exactly as returned, before any
// validation), with its model, latency, tokens, finish reason, temperature and attempts, and
// every failed call with its kind. Nothing is kept of the prompt except its version. The report
// states the model, temperature, retry limit, how many requests were made and how many failed,
// so the scoring can be redone offline after a person reviews the gold data.
//
// HOW IT STOPS. A rate limit or quota error (HTTP 429) ends the run at once. Otherwise a
// provider failure on one email is recorded and the run goes on; two DIFFERENT emails failing
// in a row end it. Nothing is retried by this runner (the adapter's own bounded retries are
// separate, and their count is in the report). A stopped run is reported as incomplete.
//
// WHAT IT DOES NOT DO. It does not decide a second time to prove determinism (that would be a
// second model request, and the plan is rules-only and covered by the mock run). It is NOT run
// by any test against a real model, and no phase may run it without the owner's go-ahead.

/** One model call as the runner saw it. */
export type RecordedCall = {
  n: number;
  purpose: string;
  promptVersion: string;
  /** The demo email the call was for (the mock keys on this; a real provider ignores it). */
  fixtureId: string | undefined;
  ok: boolean;
  /** The provider's answer exactly as returned, unvalidated. */
  response?: LlmResponse;
  error?: { kind: string; message: string; status: number | undefined; retryAfterMs: number | undefined };
};

export type RecordingProvider = LlmProvider & { readonly calls: readonly RecordedCall[] };

export function createRecordingProvider(inner: LlmProvider): RecordingProvider {
  const calls: RecordedCall[] = [];
  return {
    name: inner.name,
    configured: inner.configured,
    get calls() {
      return calls;
    },
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const record: RecordedCall = {
        n: calls.length + 1,
        purpose: request.purpose,
        promptVersion: request.promptVersion,
        fixtureId: request.metadata?.fixtureId,
        ok: false,
      };
      calls.push(record);
      try {
        const response = await inner.complete(request);
        record.ok = true;
        record.response = structuredClone(response);
        return response;
      } catch (err) {
        record.error =
          err instanceof LlmUnavailableError
            ? { kind: err.kind, message: err.message, status: err.status, retryAfterMs: err.retryAfterMs }
            : { kind: 'unknown', message: err instanceof Error ? err.message : String(err), status: undefined, retryAfterMs: undefined };
        throw err;
      }
    },
  };
}

export type RunSettings = {
  provider: string;
  model: string;
  temperature: number;
  maxRetries: number;
  timeoutMs: number;
};

export type StopReason = { kind: 'rate_limit' | 'consecutive_failures'; after: string; detail: string };

export type RealItem = {
  caseId: string;
  providerMessageId: string;
  understandState: string | null;
  decideState: string | null;
  /** Every call made for this email, in order, with the raw replies. */
  calls: RecordedCall[];
};

export type RealRunReport = {
  kind: 'real-evaluation';
  label: string;
  provenance: string;
  startedAt: string;
  settings: RunSettings;
  /** What was announced before the run started. */
  expectedRequests: { understand: number; draftsAtMost: number; note: string };
  /** Provider calls this runner made (a call retried inside the adapter counts once here; see `usage.requests`). */
  providerCalls: number;
  failedCalls: number;
  usage: UsageSummary | null;
  complete: boolean;
  stopped: StopReason | null;
  understand: { version: string; metrics: UnderstandMetrics; thresholdFailures: string[]; results: UnderstandResult[] };
  decide: { version: string; metrics: DecideReport['metrics']; thresholdFailures: string[]; results: DecideResult[] };
  items: RealItem[];
};

export function announceBudget(understandCases: number, draftsAtMost: number): RealRunReport['expectedRequests'] {
  return {
    understand: understandCases,
    draftsAtMost,
    note:
      `${understandCases} to read the emails and up to ${draftsAtMost} to draft replies: about ${understandCases + draftsAtMost} requests, ` +
      `up to ${2 * understandCases + draftsAtMost} if every email needs its one repair retry. The adapter may add bounded retries after a 429, 5xx or timeout.`,
  };
}

/** How many replies the decide dataset expects to be drafted: the most draft requests a run can make. */
export function draftCount(cases: readonly { expected: { hasDraft: boolean } }[]): number {
  return cases.filter((c) => c.expected.hasDraft).length;
}

function isRateLimit(call: RecordedCall): boolean {
  return call.error?.kind === 'rate_limit' || /quota|resource_exhausted|\b429\b/i.test(call.error?.message ?? '');
}

export async function runRealEvaluation(options: {
  provider: LlmProvider;
  settings: RunSettings;
  understandDatasetPath: string;
  decideDatasetPath: string;
  demoDataDir: string;
  migrationsDir: string;
  logger?: Logger;
  /** One line per finished email, for the operator. */
  onProgress?: (line: string) => void;
  /** What the datasets are called in the report. Defaults to the reviewed label; a rescore against the old datasets passes the legacy one. */
  goldLabel?: string;
  /** Wait between emails, to stay under a free tier's requests-per-minute. Default none (tests). */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RealRunReport> {
  const logger = options.logger ?? createLogger('eval', { level: 'error' });
  const say = options.onProgress ?? (() => {});

  const understandSet = loadDataset(options.understandDatasetPath);
  const decideSet = loadDecideDataset(options.decideDatasetPath);
  const decideByMessage = new Map(decideSet.cases.map((c) => [c.providerMessageId, c]));
  const startedAt = new Date().toISOString();

  const db = createTestDatabase();
  await runMigrations(db, options.migrationsDir, { now: () => '2026-01-01T00:00:00.000Z' });
  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds('eval'),
  });
  await seedDemoData(repos, readSeedFile(options.demoDataDir));
  await repos.settings.set('autonomy_level', decideSet.autonomyLevel, 'eval');

  const before = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };

  const provider = createRecordingProvider(options.provider);
  const source = createDemoEmailSource({ filePath: path.join(options.demoDataDir, 'emails.json') });
  const clock = createFixedClock('2026-09-01T00:00:00.000Z', 1000);
  await ingestEmails({ repos, source, logger });

  const understandResults: UnderstandResult[] = [];
  const decideResults: DecideResult[] = [];
  const items: RealItem[] = [];
  let stopped: StopReason | null = null;
  let inARow = 0;

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let first = true;

  for (const evalCase of understandSet.cases) {
    if (!first && (options.pauseMs ?? 0) > 0) await sleep(options.pauseMs ?? 0);
    first = false;
    const callsBefore = provider.calls.length;
    const email = await repos.emails.findByProviderMessageId('demo', evalCase.providerMessageId);
    if (!email) {
      understandResults.push(missingEmail(evalCase.id, evalCase.description, evalCase.providerMessageId));
      continue;
    }

    const understood = await understandEmail(email, { repos, provider, logger });
    understandResults.push(evaluateCase(evalCase, understood));
    const item: RealItem = {
      caseId: evalCase.id,
      providerMessageId: evalCase.providerMessageId,
      understandState: understood.state,
      decideState: null,
      calls: [],
    };

    const decideCase = decideByMessage.get(evalCase.providerMessageId);
    if (decideCase) {
      if (understood.state !== 'resolving') {
        decideResults.push(notReached(decideCase.id, decideCase.description, `understanding left it in ${understood.state}`));
      } else {
        const resolved = await resolveEmail(understood.email, { repos, logger });
        if (resolved.state !== 'deciding') {
          decideResults.push(notReached(decideCase.id, decideCase.description, `resolution left it in ${resolved.state}`));
        } else {
          const decided = await decideEmail(resolved.email, { repos, provider, logger, clock });
          item.decideState = decided.state;
          if (!decided.plan) {
            decideResults.push(notReached(decideCase.id, decideCase.description, 'no plan was produced', 'plan_produced'));
          } else {
            const evaluated = evaluateDecision(decideCase, decided.plan, decided.state);
            decideResults.push({
              id: decideCase.id,
              description: decideCase.description,
              passed: evaluated.checks.every((c) => c.passed),
              checks: evaluated.checks,
              unsafeActions: evaluated.unsafeActions,
              unsupportedClaims: evaluated.unsupportedClaims,
              draftsChecked: evaluated.draftsChecked,
            });
          }
        }
      }
    }

    item.calls = provider.calls.slice(callsBefore);
    items.push(item);

    const failed = item.calls.filter((call) => !call.ok);
    say(
      `${evalCase.id}: ${understood.state}${item.decideState ? ` -> ${item.decideState}` : ''}; ` +
        `${item.calls.length} request(s), ${failed.length} failed`,
    );

    const limited = failed.find(isRateLimit);
    if (limited) {
      stopped = { kind: 'rate_limit', after: evalCase.id, detail: limited.error?.message ?? 'rate limit' };
      break;
    }
    if (failed.length > 0) {
      inARow += 1;
      if (inARow >= 2) {
        stopped = {
          kind: 'consecutive_failures',
          after: evalCase.id,
          detail: `two different emails failed in a row (last: ${failed[0]?.error?.kind}: ${failed[0]?.error?.message})`,
        };
        break;
      }
    } else {
      inARow = 0;
    }
  }

  const after = {
    contacts: await repos.contacts.count(),
    companies: await repos.companies.count(),
    deals: await repos.deals.count(),
    tasks: await repos.tasks.count(),
  };
  const crmWrites =
    after.contacts - before.contacts + (after.companies - before.companies) + (after.deals - before.deals) + (after.tasks - before.tasks);
  await db.close();

  const understandMetrics = aggregate(understandResults);
  const decideMetrics = buildDecideMetrics(decideResults, { deterministic: null, crmWrites });
  const allCalls = provider.calls;

  return {
    kind: 'real-evaluation',
    label: options.goldLabel ?? GOLD_LABEL,
    provenance: GOLD_PROVENANCE,
    startedAt,
    settings: options.settings,
    expectedRequests: announceBudget(understandSet.cases.length, draftCount(decideSet.cases)),
    providerCalls: allCalls.length,
    failedCalls: allCalls.filter((call) => !call.ok).length,
    usage: summarizeUsage(allCalls.map((call) => call.response?.usage)),
    complete: stopped === null && understandResults.length === understandSet.cases.length,
    stopped,
    understand: {
      version: understandSet.version,
      metrics: understandMetrics,
      thresholdFailures: thresholdFailures(understandMetrics),
      results: understandResults,
    },
    decide: {
      version: decideSet.version,
      metrics: decideMetrics,
      thresholdFailures: decideThresholdFailures(decideMetrics),
      results: decideResults,
    },
    items,
  };
}

function missingEmail(id: string, description: string, providerMessageId: string): UnderstandResult {
  return {
    id,
    description,
    passed: false,
    checks: [{ name: 'fixture_present', passed: false, detail: `no email ${providerMessageId}` }],
    extraction: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    hallucinations: 0,
    hallucinationOpportunities: 0,
  };
}

function notReached(id: string, description: string, detail: string, name = 'reached_decide'): DecideResult {
  return {
    id,
    description,
    passed: false,
    checks: [{ name, passed: false, detail }],
    unsafeActions: 0,
    unsupportedClaims: 0,
    draftsChecked: 0,
  };
}
