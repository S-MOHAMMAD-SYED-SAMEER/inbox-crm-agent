import { createInterface } from 'node:readline/promises';
import {
  assessPopulate,
  describeIdempotence,
  verifyPopulated,
  type HealthSnapshot,
  type PipelineOutcome,
  type PopulateTargetKind,
} from '../src/demo/populate.ts';

// `npm run demo:populate`
//
// Runs the product's own pipeline against a deployment, once, so the public
// read-only demo has something in it. Pairs with `demo:reset`: that empties the
// database, this fills it.
//
//   npm run demo:populate -- https://host --local                 dry run
//   npm run demo:populate -- https://host --production            dry run
//   npm run demo:populate -- https://host --production --confirm  do it
//
// A DRY RUN IS THE DEFAULT. Without `--confirm` this reads `/api/health`,
// reports what it would do, and sends no other request.
//
// ALL OF THE JUDGEMENT LIVES IN `src/demo/populate.ts`, which is tested. This
// file prompts, prints, and makes HTTP calls.
//
// HOW IT AUTHENTICATES, AND WHAT IT REFUSES TO DO WITH THE PASSWORD
//
// The same rules M7-E's verification script follows. The password is read from
// an interactive prompt and held in memory only — never an argument (arguments
// land in shell history and the process list), never a file, never a log line.
// Nothing derived from it is printed either.
//
// WHAT IT DOES TO THE DEPLOYMENT
//
//   POST /api/emails/ingest      the demo fixtures, into the inbox
//   POST /api/emails/understand  the mock model reads them
//   POST /api/emails/resolve     matched against the CRM
//   POST /api/emails/decide      plans and drafts, which queue for approval
//
// And then it stops. It never approves, never executes, never retries and never
// sends. The approvals it leaves behind are the demonstration.

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);

const baseUrl = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/$/, '');
const declaredKind: PopulateTargetKind | null = has('--production')
  ? 'production'
  : has('--local')
    ? 'local'
    : null;
const confirmed = has('--confirm');

/** Long timeout throughout: a free-tier instance can take ~50s to wake. */
const TIMEOUT_MS = 120_000;

function line(): void {
  console.log('='.repeat(62));
}

function refuse(code: string, message: string): never {
  line();
  console.log(' REFUSED');
  line();
  console.log(`  reason : ${code}`);
  console.log(`  ${message}`);
  line();
  process.exit(1);
}

async function main(): Promise<void> {
  if (baseUrl === '') {
    refuse('no_url', 'Pass the deployment URL, e.g. npm run demo:populate -- https://host --production');
  }

  // --- what is this deployment? -------------------------------------------
  let health: HealthSnapshot | null = null;
  for (let attempt = 1; attempt <= 3 && health === null; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) health = (await response.json()) as HealthSnapshot;
    } catch {
      /* still cold — a sleeping free instance takes a moment */
    }
  }

  const assessment = assessPopulate({ declaredKind, health });
  if (!assessment.ok) refuse(assessment.code, assessment.message);

  line();
  console.log(` DEMO POPULATE — ${confirmed ? 'CONFIRMED' : 'DRY RUN (nothing will be written)'}`);
  line();
  console.log(`  target   : ${assessment.kind} (${assessment.driver})`);
  console.log(`  url      : ${baseUrl}`);
  console.log('\n  WILL RUN, in order:');
  console.log('    POST /api/emails/ingest      the demo fixtures, into the inbox');
  console.log('    POST /api/emails/understand  the mock model reads them');
  console.log('    POST /api/emails/resolve     matched against the CRM');
  console.log('    POST /api/emails/decide      plans and drafts, queued for approval');
  console.log('\n  WILL NOT: approve, execute, retry, reject or send anything.');

  if (assessment.publicWindowOpen) {
    console.log('\n  NOTE: DEMO_PUBLIC_READONLY is already on, so a visitor could be');
    console.log('        watching this happen. Populating before opening the window');
    console.log('        avoids showing anyone a half-built demo.');
  }

  if (!confirmed) {
    line();
    console.log('  Dry run. Re-run with --confirm to perform it.');
    line();
    return;
  }

  // --- sign in --------------------------------------------------------------
  if (!process.stdin.isTTY) {
    refuse('no_tty', 'The operator password is prompted for, so this needs an interactive terminal.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n  The password is held in memory only. It is never printed, stored or sent');
  console.log('  anywhere but this deployment, and nothing derived from it is displayed.\n');
  const password = await rl.question('  Operator password: ');
  rl.close();
  console.log();

  const jar = new Map<string, string>();
  const absorb = (response: Response): void => {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] as string;
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  };
  const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = (): string => decodeURIComponent(jar.get('inbox_csrf') ?? '');

  const call = async (
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrf()) headers['x-csrf-token'] = csrf();

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    absorb(response);

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON — status carries the story */
    }
    return { status: response.status, json };
  };

  const signIn = await call('/api/auth/login', { method: 'POST', body: { password } });
  if (signIn.status !== 200) {
    refuse('sign_in_failed', `The deployment refused the operator password (HTTP ${signIn.status}).`);
  }
  console.log('  Signed in.\n');

  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

  const stage = async (label: string, path: string): Promise<Record<string, unknown>> => {
    process.stdout.write(`  ${label.padEnd(12)}`);
    const result = await call(path, { method: 'POST', body: {} });
    if (result.status !== 200) {
      console.log(`FAILED (HTTP ${result.status})`);
      refuse('stage_failed', `${path} answered ${result.status}. Stopping before anything else runs.`);
    }
    console.log('ok');
    return result.json;
  };

  const ingest = await stage('ingest', '/api/emails/ingest');
  const understand = await stage('understand', '/api/emails/understand');
  const resolve = await stage('resolve', '/api/emails/resolve');
  const decide = await stage('decide', '/api/emails/decide');

  // --- what does it look like now? -----------------------------------------
  const emails = await call('/api/emails');
  const approvals = await call('/api/approvals?state=pending');

  const outcome: PipelineOutcome = {
    ingested: num(ingest.ingested),
    duplicates: num(ingest.duplicates),
    understood: num(understand.processed),
    understandFailed: num(understand.failed),
    resolved: num(resolve.resolved),
    resolveConflicts: num(resolve.conflicts),
    resolveFailed: num(resolve.failed),
    decided: num(decide.processed ?? decide.decided),
    decideFailed: num(decide.failed),
    emails: Array.isArray(emails.json.emails) ? emails.json.emails.length : 0,
    pendingApprovals: Array.isArray(approvals.json.approvals) ? approvals.json.approvals.length : 0,
  };

  line();
  console.log(' RESULT');
  line();
  console.log(`  ${describeIdempotence(outcome)}`);
  console.log(`  understood       : ${outcome.understood} (${outcome.understandFailed} failed)`);
  console.log(`  resolved         : ${outcome.resolved} (${outcome.resolveConflicts} conflicts, ${outcome.resolveFailed} failed)`);
  console.log(`  decided          : ${outcome.decided} (${outcome.decideFailed} failed)`);
  console.log(`  emails in inbox  : ${outcome.emails}`);
  console.log(`  awaiting a person: ${outcome.pendingApprovals}`);

  const check = verifyPopulated(outcome);
  line();
  if (check.ready) {
    console.log(' READY — the demo has something to show');
    line();
    console.log('  An inbox with mail, decisions queued for a person, and the CRM');
    console.log('  rows the agent wrote. Safe to open DEMO_PUBLIC_READONLY now.');
  } else {
    console.log(' NOT READY — review before opening the demo');
    line();
    for (const problem of check.problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  }
  line();
}

main().catch((err: unknown) => {
  console.error('[demo:populate] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
