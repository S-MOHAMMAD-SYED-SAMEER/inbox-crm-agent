import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  toErrorEnvelope,
  ERROR_CODES,
} from '../src/lib/errors.ts';
import {
  ProblemCollector,
  requireString,
  optionalString,
  requireOneOf,
  requireEmail,
  requireIsoTimestamp,
  requireNumberInRange,
  requireObject,
  optionalInteger,
} from '../src/lib/validate.ts';
import { maskEmail, redactText, redactValue } from '../src/lib/redact.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { newId, isUuid, stableHash, canonicalJson, deterministicId, createSequentialIds } from '../src/lib/ids.ts';
import { createFixedClock, systemClock, isIsoTimestamp } from '../src/lib/clock.ts';
import { confidenceBand, CONFIDENCE_THRESHOLDS } from '../src/domain/email.ts';
import { normaliseCompanyName, domainFromEmail } from '../src/domain/crm.ts';

// --- errors -----------------------------------------------------------------

test('sequential ids are deterministic AND valid UUIDs (M5-E regression)', () => {
  // They used to be `prefix-1`, which SQLite accepted because it maps the
  // schema's UUID columns to TEXT. PostgreSQL enforces the type, so the first
  // insert against a real server failed and every test and evaluation was
  // incapable of running there. Both properties matter now: determinism makes a
  // failure reproducible, UUID-validity makes it runnable on the database this
  // project deploys to.
  const first = createSequentialIds('regression');
  const second = createSequentialIds('regression');

  const a = [first(), first(), first()];
  const b = [second(), second(), second()];

  assert.deepEqual(a, b, 'the same prefix produced a different sequence');
  assert.equal(new Set(a).size, 3, 'the generator repeated an id');

  for (const id of a) {
    assert.ok(isUuid(id), `"${id}" is not a valid UUID and Postgres would refuse it`);
  }

  // A different prefix gives a different sequence, which is what keeps two test
  // contexts from colliding.
  const other = createSequentialIds('different');
  assert.notEqual(other(), a[0]);
});

test('an AppError maps to its status and envelope', () => {
  const err = new AppError('NOT_FOUND', 'Nothing here.');
  assert.equal(err.status, 404);
  assert.deepEqual(err.toEnvelope(), { error: { code: 'NOT_FOUND', message: 'Nothing here.' } });
});

test('every error code maps to a status', () => {
  for (const code of ERROR_CODES) {
    const err = new AppError(code, 'test');
    assert.ok(err.status >= 400 && err.status < 600, `${code} has no sensible status`);
  }
});

test('a validator collects every problem, not just the first', () => {
  const problems = new ProblemCollector();
  requireString(undefined, 'a', problems);
  requireString(42, 'b', problems);
  requireEmail('nope', 'c', problems);

  assert.equal(problems.count, 3);
  try {
    problems.throwIfAny();
    assert.fail('expected a ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.problems.length, 3);
    assert.equal((err.details.problems as string[]).length, 3);
  }
});

test('an unknown thrown value never leaks its message to the client', () => {
  const leaky = new Error('connection to postgres://user:hunter2@db.example failed');
  const { status, body, internal } = toErrorEnvelope(leaky);

  assert.equal(status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(body.error.message, /postgres|hunter2|db\.example/);
  // The real message is still available — for the log, which is where it goes.
  assert.match(internal, /hunter2/);
});

test('a non-Error thrown value is handled without crashing the error handler', () => {
  const { status, body } = toErrorEnvelope('just a string');
  assert.equal(status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
});

test('NotFoundError and ConflictError carry the right codes', () => {
  assert.equal(new NotFoundError('Deal').code, 'NOT_FOUND');
  assert.equal(new ConflictError('Already exists').code, 'CONFLICT');
});

// --- validators -------------------------------------------------------------

test('requireOneOf rejects a value outside the allowed set and lists them', () => {
  const problems = new ProblemCollector();
  requireOneOf('purple', 'colour', ['red', 'green'] as const, problems);
  assert.equal(problems.count, 1);
  assert.match(problems.list()[0] as string, /red, green/);
});

test('optionalString treats undefined, null and empty as absent', () => {
  const problems = new ProblemCollector();
  assert.equal(optionalString(undefined, 'a', problems), null);
  assert.equal(optionalString(null, 'b', problems), null);
  assert.equal(optionalString('', 'c', problems), null);
  assert.equal(problems.count, 0);
});

test('requireEmail normalises case and trims', () => {
  const problems = new ProblemCollector();
  assert.equal(requireEmail('  Sarah@AcmeCommerce.INVALID ', 'email', problems), 'sarah@acmecommerce.invalid');
  assert.equal(problems.count, 0);
});

test('requireIsoTimestamp rejects nonsense and normalises valid input', () => {
  const problems = new ProblemCollector();
  assert.equal(requireIsoTimestamp('2026-08-24T10:00:00Z', 'at', problems), '2026-08-24T10:00:00.000Z');
  requireIsoTimestamp('not a date', 'bad', problems);
  assert.equal(problems.count, 1);
});

test('requireNumberInRange rejects out-of-range and non-finite values', () => {
  const problems = new ProblemCollector();
  requireNumberInRange(1.5, 'confidence', 0, 1, problems);
  requireNumberInRange(Number.NaN, 'nan', 0, 1, problems);
  requireNumberInRange('0.5', 'string', 0, 1, problems);
  assert.equal(problems.count, 3);
});

test('requireObject rejects arrays and null', () => {
  const problems = new ProblemCollector();
  requireObject([], 'a', problems);
  requireObject(null, 'b', problems);
  requireObject({ ok: true }, 'c', problems);
  assert.equal(problems.count, 2);
});

test('optionalInteger enforces bounds only when a value is present', () => {
  const problems = new ProblemCollector();
  assert.equal(optionalInteger(undefined, 'a', problems, { min: 1 }), null);
  optionalInteger(0, 'b', problems, { min: 1 });
  optionalInteger(1.5, 'c', problems);
  assert.equal(problems.count, 2);
});

// --- redaction (NFR-12) -----------------------------------------------------

test('an email address is masked but its domain survives', () => {
  assert.equal(maskEmail('sarah@acmecommerce.invalid'), 's***h@acmecommerce.invalid');
  assert.equal(maskEmail('jo@brightpath.invalid'), '**@brightpath.invalid');
});

test('redactText masks addresses and phone numbers inside free text', () => {
  const out = redactText('Contact sarah@acmecommerce.invalid or call +44 20 7946 0102 today');
  assert.doesNotMatch(out, /sarah@/);
  assert.match(out, /acmecommerce\.invalid/);
  assert.match(out, /\[phone:\d+d\]/);
});

test('an email body is never logged, whatever it contains', () => {
  const redacted = redactValue({
    subject: 'Shopify AI chatbot project',
    bodyText: 'We run a small Shopify store and our card number is 4111 1111 1111 1111',
    apiKey: 'sk-ant-secret',
    nested: { databaseUrl: 'postgres://user:pass@host/db' },
  }) as Record<string, unknown>;

  assert.match(String(redacted.bodyText), /^\[redacted:\d+c\]$/);
  assert.equal(redacted.apiKey, '[redacted:13c]');
  assert.equal((redacted.nested as Record<string, unknown>).databaseUrl, '[redacted:28c]');
  assert.equal(redacted.subject, 'Shopify AI chatbot project');
});

test('the logger redacts context before it reaches the sink', () => {
  const { logger, entries } = createMemoryLogger('test');
  logger.info('processing', { fromEmail: 'sarah@acmecommerce.invalid', bodyText: 'secret contents' });

  const context = entries[0]?.context as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(context), /sarah@acmecommerce\.invalid/);
  assert.doesNotMatch(JSON.stringify(context), /secret contents/);
});

test('the logger honours its level', () => {
  const { logger, entries } = createMemoryLogger();
  logger.debug('should appear at debug level');
  assert.equal(entries.length, 1);
});

// --- ids and clock ----------------------------------------------------------

test('newId produces valid UUIDs', () => {
  assert.ok(isUuid(newId()));
  assert.notEqual(newId(), newId());
});

test('deterministicId is stable and UUID-shaped', () => {
  const first = deterministicId('company:harborview-digital');
  assert.ok(isUuid(first));
  assert.equal(first, deterministicId('company:harborview-digital'));
  assert.notEqual(first, deterministicId('company:harborview-media'));
});

test('sequential ids are deterministic and ordered', () => {
  // CONTRACT CHANGE (M5-E): these were `email-1`, `email-2` — readable, and
  // rejected by PostgreSQL, which enforces the schema's UUID columns where
  // SQLite maps them to TEXT. Readability was traded for the ability to run the
  // suite against the database this project deploys to. Determinism and
  // ordering, which are what the tests actually depend on, are unchanged.
  const next = createSequentialIds('email');
  const again = createSequentialIds('email');

  assert.equal(next(), deterministicId('email-1'));
  assert.equal(next(), deterministicId('email-2'));

  // Same prefix, same order, same ids — on every run.
  assert.equal(again(), deterministicId('email-1'));
});

test('stableHash ignores key order but not values', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

test('canonicalJson drops undefined and sorts keys', () => {
  assert.equal(canonicalJson({ b: 1, a: undefined, c: [1, 2] }), '{"b":1,"c":[1,2]}');
});

test('a fixed clock advances so events stay orderable', () => {
  const clock = createFixedClock('2026-06-01T00:00:00.000Z', 1000);
  const first = clock.nowIso();
  const second = clock.nowIso();

  assert.equal(first, '2026-06-01T00:00:00.000Z');
  assert.equal(second, '2026-06-01T00:00:01.000Z');
  assert.ok(second > first, 'a frozen clock would let an ordering bug pass');
});

test('the system clock emits the one timestamp format this system uses', () => {
  assert.ok(isIsoTimestamp(systemClock.nowIso()));
});

// --- domain helpers ---------------------------------------------------------

test('confidence banding matches the documented thresholds', () => {
  assert.equal(confidenceBand(0.91), 'high');
  assert.equal(confidenceBand(CONFIDENCE_THRESHOLDS.high), 'high', 'the boundary belongs to the higher band');
  assert.equal(confidenceBand(0.79), 'medium');
  assert.equal(confidenceBand(CONFIDENCE_THRESHOLDS.medium), 'medium');
  assert.equal(confidenceBand(0.41), 'low');
  assert.equal(confidenceBand(0), 'low');
});

test('an out-of-range confidence throws rather than banding as low', () => {
  assert.throws(() => confidenceBand(1.4), RangeError);
  assert.throws(() => confidenceBand(-0.1), RangeError);
  assert.throws(() => confidenceBand(Number.NaN), RangeError);
});

test('company name normalisation strips legal suffixes and punctuation', () => {
  assert.equal(normaliseCompanyName('Harborview Media Ltd'), 'harborview media');
  assert.equal(normaliseCompanyName('Acme Commerce, Inc.'), 'acme commerce');
  assert.equal(normaliseCompanyName('Solstice  Retail'), 'solstice retail');
  assert.equal(normaliseCompanyName('Smith & Jones LLC'), 'smith and jones');
});

test('normalisation never strips a name down to nothing', () => {
  assert.equal(normaliseCompanyName('Group'), 'group');
  assert.equal(normaliseCompanyName('Ltd'), 'ltd');
});

test('a leading suffix-like word is part of the name', () => {
  assert.equal(normaliseCompanyName('Co-op Digital'), 'co op digital');
});

test('domainFromEmail returns null rather than guessing', () => {
  assert.equal(domainFromEmail('Sarah@AcmeCommerce.invalid'), 'acmecommerce.invalid');
  assert.equal(domainFromEmail('not-an-email'), null);
  assert.equal(domainFromEmail('two@@at.com'), null);
  assert.equal(domainFromEmail('missing@domain'), null);
});
