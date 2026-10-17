import type { RealRunReport } from './runner.ts';

// Run-to-run variance of a real-model evaluation.
//
// A model at temperature 1 does not give the same answer twice, so one run is one sample. This reads several saved
// reports of the same evaluation and says, for every metric, how far apart the runs were (min, median, max), and for
// every case how many runs passed it, which category each run gave it, and how often it reached a person. The last matters
// most for the cases that exist to be handed to a human: a single run that happens to route one correctly says little.

export type Spread = { min: number; median: number; max: number; values: number[] };

export type CaseVariance = {
  id: string;
  /** Runs, out of the total, in which the UNDERSTAND checks all passed. */
  understandPassed: number;
  /** Runs in which the DECIDE checks all passed; null when the case is not a DECIDE case. */
  decidePassed: number | null;
  /** Runs in which the email ended UNDERSTAND with a person (needs_review). */
  reachedPerson: number;
  /** The category the pipeline settled on in each run, in run order (null where the model gave no answer). */
  categories: Array<string | null>;
  /** The state the email was left in after UNDERSTAND in each run. */
  states: Array<string | null>;
};

export type VarianceSummary = {
  runs: number;
  requests: number;
  failedRequests: number;
  completeRuns: number;
  understand: Record<string, Spread>;
  decide: Record<string, Spread>;
  cases: CaseVariance[];
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Number(value.toFixed(4));
}

function spread(values: number[]): Spread {
  return { min: Math.min(...values), median: median(values), max: Math.max(...values), values };
}

function spreadOf(metrics: Array<Record<string, unknown>>): Record<string, Spread> {
  const out: Record<string, Spread> = {};
  const names = Object.keys(metrics[0] ?? {});
  for (const name of names) {
    const values = metrics.map((m) => m[name]);
    if (values.every((value): value is number => typeof value === 'number')) out[name] = spread(values);
  }
  return out;
}

function categoryOf(report: RealRunReport, id: string): string | null {
  const check = report.understand.results.find((result) => result.id === id)?.checks.find((c) => c.name === 'category');
  const got = /, got (\S+)$/.exec(check?.detail ?? '');
  return got?.[1] ?? null;
}

export function summariseRuns(reports: readonly RealRunReport[]): VarianceSummary {
  if (reports.length === 0) throw new Error('summariseRuns needs at least one report');
  const ids = [...new Set(reports.flatMap((report) => report.understand.results.map((result) => result.id)))];

  const cases: CaseVariance[] = ids.map((id) => {
    const understand = reports.map((report) => report.understand.results.find((result) => result.id === id));
    const decide = reports.map((report) => report.decide.results.find((result) => result.id === id));
    const items = reports.map((report) => report.items.find((item) => item.caseId === id));
    return {
      id,
      understandPassed: understand.filter((result) => result?.passed === true).length,
      decidePassed: decide.every((result) => result === undefined) ? null : decide.filter((result) => result?.passed === true).length,
      reachedPerson: items.filter((item) => item?.understandState === 'needs_review').length,
      categories: reports.map((report) => categoryOf(report, id)),
      states: items.map((item) => item?.understandState ?? null),
    };
  });

  return {
    runs: reports.length,
    requests: reports.reduce((sum, report) => sum + report.providerCalls, 0),
    failedRequests: reports.reduce((sum, report) => sum + report.failedCalls, 0),
    completeRuns: reports.filter((report) => report.complete).length,
    understand: spreadOf(reports.map((report) => report.understand.metrics as unknown as Record<string, unknown>)),
    decide: spreadOf(reports.map((report) => report.decide.metrics as unknown as Record<string, unknown>)),
    cases,
  };
}
