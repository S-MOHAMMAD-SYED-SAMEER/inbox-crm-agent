import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createTestContext } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { hashPassword } from '../src/lib/password.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { readSeedFile, seedDemoData } from '../src/db/seed.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import {
  assessPopulate,
  describeIdempotence,
  verifyPopulated,
  POPULATE_REFUSAL_CODES,
  type PipelineOutcome,
} from '../src/demo/populate.ts';
import type { AppConfig } from '../src/config/env.ts';

// P19 — populating the public demo.
//
// Two halves, matching the split in the code. The refusal logic is pure and is
// attacked directly with malformed and hostile health responses. The pipeline
// itself is driven end to end over real HTTP against a real app, because the
// claim that matters — "this leaves a demo worth showing" — is not something a
// unit test of a decision function can make.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'a-long-enough-operator-password';
const quiet = createMemoryLogger().logger;

/** A health body from a deployment that should be accepted. */
const HEALTHY = {
  status: 'ok',
  database: { driver: 'postgres', reachable: true, migrationsApplied: 10 },
  adapters: {
    llmProvider: 'mock',
    outboundSendEnabled: false,
    authConfigured: true,
    demoPublicReadonly: false,
  },
};

// --- the gates ---------------------------------------------------------------

test('a healthy production deployment is accepted', () => {
  const result = assessPopulate({ declaredKind: 'production', health: HEALTHY });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.kind, 'production');
  assert.equal(result.driver, 'postgres');
  assert.equal(result.publicWindowOpen, false);
});

test('a target must be declared, exactly as the reset requires', () => {
  const result = assessPopulate({ declaredKind: null, health: HEALTHY });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'no_target_declared');
});

test('an unreachable or unreadable deployment is refused, not retried into', () => {
  for (const health of [
    null,
    {},
    { database: {} },
    { database: { driver: 'postgres' } },
    { database: { driver: 'postgres', reachable: false } },
    { database: { reachable: 'yes' } } as never,
  ]) {
    const result = assessPopulate({ declaredKind: 'production', health });
    assert.equal(result.ok, false, `${JSON.stringify(health)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.code, 'unreachable');
  }
});

test('declaring production against a local database is refused', () => {
  const result = assessPopulate({
    declaredKind: 'production',
    health: { ...HEALTHY, database: { driver: 'sqlite', reachable: true } },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'driver_mismatch');
});

test('declaring local against a hosted database is refused too', () => {
  const result = assessPopulate({ declaredKind: 'local', health: HEALTHY });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'driver_mismatch');
});

test('a real model provider is refused: non-deterministic, and it spends money', () => {
  for (const provider of ['anthropic', 'gemini', '', undefined, null, 'Mock', 1]) {
    const result = assessPopulate({
      declaredKind: 'production',
      health: { ...HEALTHY, adapters: { ...HEALTHY.adapters, llmProvider: provider as never } },
    });

    assert.equal(result.ok, false, `provider ${String(provider)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.code, 'provider_not_mock');
  }
});

test('a deployment that can send mail is refused outright', () => {
  // The script drafts replies. Anywhere a draft could leave the building is
  // somewhere it will not run, regardless of it never asking for an execution.
  for (const value of [true, 'false', 'no', 0, 1, undefined, null]) {
    const result = assessPopulate({
      declaredKind: 'production',
      health: { ...HEALTHY, adapters: { ...HEALTHY.adapters, outboundSendEnabled: value as never } },
    });

    assert.equal(result.ok, false, `outboundSendEnabled ${String(value)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.code, 'outbound_enabled');
  }
});

test('a deployment with no operator password is refused', () => {
  for (const value of [false, undefined, null, 'true', 1]) {
    const result = assessPopulate({
      declaredKind: 'production',
      health: { ...HEALTHY, adapters: { ...HEALTHY.adapters, authConfigured: value as never } },
    });

    assert.equal(result.ok, false, `authConfigured ${String(value)} was accepted`);
    if (result.ok) continue;
    assert.equal(result.code, 'auth_not_configured');
  }
});

test('an already-open public window is reported, not refused', () => {
  // Re-populating a live demo is legitimate. The operator is told a visitor
  // could be watching; they are not blocked from fixing it.
  const result = assessPopulate({
    declaredKind: 'production',
    health: { ...HEALTHY, adapters: { ...HEALTHY.adapters, demoPublicReadonly: true } },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.publicWindowOpen, true);
});

test('every refusal code the module can emit is declared', () => {
  const declared = new Set<string>(POPULATE_REFUSAL_CODES);
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'src/demo/populate.ts'), 'utf8');

  for (const match of source.matchAll(/code: '([a-z_]+)'/g)) {
    assert.ok(declared.has(match[1] as string), `${match[1]} is emitted but not declared`);
  }
});

// --- is the result worth showing? -------------------------------------------

const FULL: PipelineOutcome = {
  ingested: 10,
  duplicates: 0,
  understood: 10,
  understandFailed: 0,
  resolved: 10,
  resolveConflicts: 1,
  resolveFailed: 0,
  decided: 10,
  decideFailed: 0,
  emails: 10,
  pendingApprovals: 4,
};

test('a full run is ready', () => {
  const check = verifyPopulated(FULL);
  assert.equal(check.ready, true, check.problems.join('; '));
});

test('an empty inbox is not ready, however cleanly the run finished', () => {
  const check = verifyPopulated({ ...FULL, emails: 0 });
  assert.equal(check.ready, false);
  assert.match(check.problems.join(' '), /inbox is empty/);
});

test('no pending approval is not ready, because that is the demonstration', () => {
  const check = verifyPopulated({ ...FULL, pendingApprovals: 0 });
  assert.equal(check.ready, false);
  assert.match(check.problems.join(' '), /waiting on a person/);
});

test('a failure at any stage is surfaced', () => {
  assert.equal(verifyPopulated({ ...FULL, understandFailed: 1 }).ready, false);
  assert.equal(verifyPopulated({ ...FULL, resolveFailed: 1 }).ready, false);
  assert.equal(verifyPopulated({ ...FULL, decideFailed: 1 }).ready, false);
});

test('a match conflict is not a failure — it is a screen worth showing', () => {
  assert.equal(verifyPopulated({ ...FULL, resolveConflicts: 3 }).ready, true);
});

test('idempotence is described from the numbers, not assumed', () => {
  assert.match(describeIdempotence(FULL), /Ingested 10 message/);
  assert.match(
    describeIdempotence({ ...FULL, ingested: 0, duplicates: 10 }),
    /Nothing new was ingested; all 10/,
  );
});

// --- the pipeline, end to end, over real HTTP --------------------------------

async function serve(): Promise<{ url: string; stop(): Promise<void> }> {
  const ctx = await createTestContext({ idPrefix: 'p19pop' });
  const { config } = loadConfig({});
  const appConfig: AppConfig = {
    ...config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    sessionTtlHours: 12,
    cookieSecure: false,
  };

  // The CRM the agent resolves against, exactly as `demo:reset` restores it.
  await seedDemoData(createRepositories(ctx.db), readSeedFile(appConfig.demoDataDir));

  const app = createApp({ db: ctx.db, config: appConfig, logger: quiet });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

/** Drives the same four stages the script drives, the same way. */
async function runPipeline(url: string): Promise<PipelineOutcome> {
  const jar = new Map<string, string>();
  const absorb = (response: Response): void => {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] as string;
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const call = async (p: string, method = 'GET'): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const token = decodeURIComponent(jar.get(CSRF_COOKIE) ?? '');
    if (method !== 'GET' && token) headers['x-csrf-token'] = token;

    const response = await fetch(`${url}${p}`, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    absorb(response);
    assert.equal(response.status, 200, `${method} ${p} answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200, 'sign-in failed');
  absorb(login);
  assert.ok(readCookie(login.headers.getSetCookie().join('; '), SESSION_COOKIE) !== null);

  const ingest = await call('/api/emails/ingest', 'POST');
  const understand = await call('/api/emails/understand', 'POST');
  const resolve = await call('/api/emails/resolve', 'POST');
  const decide = await call('/api/emails/decide', 'POST');
  const emails = await call('/api/emails');
  const approvals = await call('/api/approvals?state=pending');

  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    ingested: n(ingest.ingested),
    duplicates: n(ingest.duplicates),
    understood: n(understand.processed),
    understandFailed: n(understand.failed),
    resolved: n(resolve.resolved),
    resolveConflicts: n(resolve.conflicts),
    resolveFailed: n(resolve.failed),
    decided: n(decide.processed ?? decide.decided),
    decideFailed: n(decide.failed),
    emails: Array.isArray(emails.emails) ? emails.emails.length : 0,
    pendingApprovals: Array.isArray(approvals.approvals) ? approvals.approvals.length : 0,
  };
}

test('the four stages leave a demo that verifyPopulated calls ready', async () => {
  const server = await serve();
  try {
    const outcome = await runPipeline(server.url);

    assert.ok(outcome.ingested > 0, 'nothing was ingested');
    assert.ok(outcome.emails > 0, 'the inbox is empty');
    assert.ok(outcome.pendingApprovals > 0, 'nothing is waiting on a person');
    assert.equal(outcome.understandFailed, 0);
    assert.equal(outcome.resolveFailed, 0);
    assert.equal(outcome.decideFailed, 0);

    const check = verifyPopulated(outcome);
    assert.equal(check.ready, true, check.problems.join('; '));
  } finally {
    await server.stop();
  }
});

test('running it twice ingests nothing new and does not double the inbox', async () => {
  const server = await serve();
  try {
    const first = await runPipeline(server.url);
    const second = await runPipeline(server.url);

    assert.equal(second.ingested, 0, 'a second run ingested fresh copies');
    assert.equal(second.duplicates, first.ingested, 'the fixtures were not all recognised');
    assert.equal(second.emails, first.emails, 'the inbox grew on a second run');
    assert.match(describeIdempotence(second), /Nothing new was ingested/);
  } finally {
    await server.stop();
  }
});

test('two independent runs reach the same state, so the demo is deterministic', async () => {
  const a = await serve();
  const b = await serve();
  try {
    const first = await runPipeline(a.url);
    const second = await runPipeline(b.url);
    assert.deepEqual(second, first, 'two fresh deployments disagreed');
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('the populated demo carries only .invalid addresses', async () => {
  const server = await serve();
  try {
    await runPipeline(server.url);

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    // Every projection a public visitor can read.
    for (const p of ['/api/emails', '/api/companies', '/api/contacts', '/api/deals', '/api/tasks', '/api/audit']) {
      const body = await (await fetch(`${server.url}${p}`, { headers: { cookie } })).text();

      for (const host of body.match(/@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) {
        assert.match(host, /\.(invalid|example|test)$/i, `${p} exposes ${host}`);
      }
    }
  } finally {
    await server.stop();
  }
});

test('populating never approves, executes or sends anything', async () => {
  const server = await serve();
  try {
    const outcome = await runPipeline(server.url);

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    const approved = (await (
      await fetch(`${server.url}/api/approvals?state=approved`, { headers: { cookie } })
    ).json()) as { approvals?: unknown[] };
    const rejected = (await (
      await fetch(`${server.url}/api/approvals?state=rejected`, { headers: { cookie } })
    ).json()) as { approvals?: unknown[] };

    assert.equal(approved.approvals?.length ?? 0, 0, 'the populate sequence approved something');
    assert.equal(rejected.approvals?.length ?? 0, 0, 'the populate sequence rejected something');
    assert.ok(outcome.pendingApprovals > 0, 'everything settled, so nothing is left to demonstrate');
  } finally {
    await server.stop();
  }
});

// --- the script itself holds no decisions -----------------------------------

test('the script defers every judgement to the tested module', () => {
  const script = fs.readFileSync(path.join(SERVER_ROOT, 'scripts/demo-populate.ts'), 'utf8');

  assert.match(script, /assessPopulate\(/, 'the script does not ask for permission');
  assert.match(script, /verifyPopulated\(/, 'the script does not check the result');

  // A dry run is the default, and only --confirm writes.
  assert.match(script, /has\('--confirm'\)/);
  assert.match(script, /DRY RUN/);

  // It stops at decide. None of these may appear as a request it makes.
  for (const forbidden of ['/approve', '/execute', '/reject', '/retry', '/revise']) {
    assert.ok(!script.includes(`'/api/decisions/${forbidden}`), `the script calls ${forbidden}`);
  }
  assert.ok(!/method: 'POST', body: \{ password \} \}\);[\s\S]*console\.log\(password/.test(script));
});

test('the password is prompted for, never an argument and never printed', () => {
  const script = fs.readFileSync(path.join(SERVER_ROOT, 'scripts/demo-populate.ts'), 'utf8');

  assert.match(script, /createInterface/, 'the password is not prompted for');

  // Strip string and template literals before looking for the identifier. The
  // script talks about the password at length - "held in memory only", "never
  // printed" - and prose mentioning it must not read as a leak. What matters is
  // whether the *variable* reaches an output call.
  const withoutText = script
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  assert.ok(
    !/console\.(log|error|warn|info)\([^)]*\bpassword\b/.test(withoutText),
    'the password variable reaches an output call',
  );
  assert.ok(
    !/process\.argv[\s\S]{0,80}\bpassword\b/.test(withoutText),
    'the password may come from an argument',
  );
  assert.ok(
    !/writeFile[\s\S]{0,80}\bpassword\b/.test(withoutText),
    'the password may be written to disk',
  );

  // Declared once, and used for exactly one thing: the sign-in body.
  const uses = [...withoutText.matchAll(/\bpassword\b/g)];
  assert.ok(uses.length > 0, 'the password identifier vanished');
  assert.ok(uses.length <= 3, `the password identifier is used ${uses.length} times`);
});
