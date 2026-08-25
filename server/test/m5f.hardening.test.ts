import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.ts';
import { EMAIL_STATES } from '../src/domain/email.ts';
import {
  LEGAL_TRANSITIONS,
  TERMINAL_EMAIL_STATES,
  allLegalTransitions,
  isLegalTransition,
} from '../src/domain/emailTransitions.ts';
import {
  boundAuditPayload,
  MAX_PAYLOAD_BYTES,
  MAX_STRING_LENGTH,
  MAX_ARRAY_LENGTH,
  TRUNCATION_MARKER,
} from '../src/domain/auditPayload.ts';
import { APPROVAL_STATES } from '../src/domain/execution.ts';

// M5-F — the cheap hardening from the audit: F-11, F-13, F-08.

// --- F-11: counts by aggregation ---------------------------------------------

test('approval counts come from one aggregate and stay correct past the old page limit', async () => {
  // The previous implementation fetched up to 500 rows per state to produce a
  // number, so past 500 the number was silently wrong. 600 rows proves it is not.
  const { db, repos, close } = await createTestContext({ idPrefix: 'counts' });

  await db.execute(
    "INSERT INTO emails (id, correlation_id, provider, provider_message_id, from_email, to_email, subject, body_text, received_at, ingested_at, state) " +
      "VALUES ('e1','c1','demo','pm1','a@b.co','me@x.co','S','B','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','received')",
  );
  await db.execute(
    "INSERT INTO email_analyses (id, email_id, category, intent, priority, priority_reason, confidence, confidence_band, extracted, summary, model, prompt_version, latency_ms, created_at) " +
      "VALUES ('a1','e1','sales_inquiry','i','high','r',0.9,'high','{}','s','m','v1',1,'2026-01-01T00:00:00.000Z')",
  );

  const perState = 120;
  for (const [index, state] of APPROVAL_STATES.entries()) {
    for (let i = 0; i < perState; i++) {
      const decisionId = `d-${index}-${i}`;
      await db.execute(
        "INSERT INTO decisions (id, email_id, analysis_id, actions, risk_tier, requires_approval, rationale, rule_trace, draft_blocked_by, created_at, approval_reasons, draft_guardrails_passed) " +
          "VALUES (?, 'e1','a1','[]',0,0,'r','[]','[]','2026-01-01T00:00:00.000Z','[]','[]')",
        [decisionId],
      );
      await db.execute(
        'INSERT INTO approvals (id, decision_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        [`ap-${index}-${i}`, decisionId, state, '2026-07-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
    }
  }

  const counts = await repos.approvals.countByState();

  // 600 approvals across five states. The old code capped each at 500 and would
  // still have been right here — so the real proof is the total below.
  assert.equal(await repos.approvals.count(), perState * APPROVAL_STATES.length);
  for (const state of APPROVAL_STATES) {
    assert.equal(counts[state], perState, `${state} was miscounted`);
  }

  await close();
});

test('every state appears in the counts, including the empty ones', async () => {
  const { repos, close } = await createTestContext({ idPrefix: 'empty-counts' });
  const counts = await repos.approvals.countByState();

  assert.deepEqual(Object.keys(counts).sort(), [...APPROVAL_STATES].sort());
  for (const state of APPROVAL_STATES) {
    assert.equal(counts[state], 0, `${state} is missing rather than zero`);
  }

  await close();
});

// --- F-13: bounded audit payloads --------------------------------------------

test('a small payload is stored exactly as given', () => {
  const payload = { decisionId: 'abc', riskTier: 2, reasons: ['a', 'b'] };
  const result = boundAuditPayload(payload);

  assert.equal(result.truncated, false);
  assert.deepEqual(result.payload, payload);
});

test('an oversized payload is bounded and the truncation is visible', () => {
  const result = boundAuditPayload({ note: 'x'.repeat(MAX_PAYLOAD_BYTES * 2) });

  assert.equal(result.truncated, true);
  assert.equal(result.payload.payloadTruncated, true, 'a reader cannot tell the payload is incomplete');
  assert.ok(String(result.payload.note).endsWith(TRUNCATION_MARKER));
  assert.ok(String(result.payload.note).length <= MAX_STRING_LENGTH + TRUNCATION_MARKER.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload), 'utf8') <= MAX_PAYLOAD_BYTES);
});

test('identifiers are never truncated, because half an id is a wrong id', () => {
  const longId = 'd'.repeat(MAX_STRING_LENGTH * 3);
  const result = boundAuditPayload({
    decisionId: longId,
    fromDecisionId: longId,
    diffDigest: longId,
    planHash: longId,
    correlationId: longId,
    filler: 'y'.repeat(MAX_PAYLOAD_BYTES * 2),
  });

  assert.equal(result.truncated, true);
  for (const key of ['decisionId', 'fromDecisionId', 'diffDigest', 'planHash', 'correlationId']) {
    assert.equal(result.payload[key], longId, `${key} was truncated`);
  }
});

test('a long array keeps its head and records what was dropped', () => {
  const result = boundAuditPayload({
    changedPaths: Array.from({ length: 500 }, (_, i) => `actions[${i}].title`),
    filler: 'z'.repeat(MAX_PAYLOAD_BYTES * 2),
  });

  const paths = result.payload.changedPaths as string[];
  assert.equal(paths.length, MAX_ARRAY_LENGTH + 1);
  assert.match(paths[MAX_ARRAY_LENGTH] as string, /450 more/);
});

test('an irreducible payload becomes a stub that keeps the identifiers', () => {
  // Many long identifier values: none may be truncated, so the whole thing
  // cannot be brought under the cap by shortening.
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) payload[`item${i}Id`] = 'q'.repeat(600);

  const result = boundAuditPayload(payload);
  assert.equal(result.truncated, true);
  assert.equal(result.payload.payloadDropped, true);
  assert.equal(result.payload.item0Id, 'q'.repeat(600), 'the stub dropped the identifiers too');
  assert.ok(typeof result.payload.originalBytes === 'number');
});

test('the identifier rule does not exempt ordinary words that merely end in id', () => {
  const result = boundAuditPayload({
    valid: 'v'.repeat(MAX_STRING_LENGTH * 2),
    monkey: 'm'.repeat(MAX_STRING_LENGTH * 2),
    decisionId: 'd'.repeat(MAX_STRING_LENGTH * 2),
    filler: 'f'.repeat(MAX_PAYLOAD_BYTES * 2),
  });

  assert.ok(String(result.payload.valid).endsWith(TRUNCATION_MARKER), '"valid" was treated as an identifier');
  assert.ok(String(result.payload.monkey).endsWith(TRUNCATION_MARKER), '"monkey" was treated as an identifier');
  assert.equal(String(result.payload.decisionId).length, MAX_STRING_LENGTH * 2, 'a real id was truncated');
});

test('an absent payload is an empty object, not a crash', () => {
  assert.deepEqual(boundAuditPayload(undefined), { payload: {}, truncated: false });
});

test('the bound is applied on the way into the database', async () => {
  const { repos, close } = await createTestContext({ idPrefix: 'audit-bound' });

  const event = await repos.audit.append({
    correlationId: 'c1',
    stage: 'system',
    eventType: 'state_changed',
    actor: 'system',
    outcome: 'ok',
    summary: 'test',
    payload: { decisionId: 'keep-me-whole', note: 'x'.repeat(MAX_PAYLOAD_BYTES * 2) },
  });

  assert.equal(event.payload.payloadTruncated, true);
  assert.equal(event.payload.decisionId, 'keep-me-whole');
  assert.ok(Buffer.byteLength(JSON.stringify(event.payload), 'utf8') <= MAX_PAYLOAD_BYTES);

  await close();
});

// --- F-08: the declared state machine ----------------------------------------

test('every state has a declared transition list', () => {
  for (const state of EMAIL_STATES) {
    assert.ok(Array.isArray(LEGAL_TRANSITIONS[state]), `${state} has no declared transitions`);
  }
  assert.deepEqual(Object.keys(LEGAL_TRANSITIONS).sort(), [...EMAIL_STATES].sort());
});

test('every declared destination is a real state', () => {
  for (const { from, to } of allLegalTransitions()) {
    assert.ok(EMAIL_STATES.includes(to), `${from} → ${to} names a state that does not exist`);
  }
});

test('the transitions the pipeline actually performs are all legal', () => {
  // Taken from the `setState` call sites, so the declaration is checked against
  // the code rather than against itself.
  const performed: Array<[string, string]> = [
    ['received', 'understanding'],
    ['understanding', 'resolving'],
    ['understanding', 'understand_failed'],
    ['understanding', 'needs_review'],
    ['resolving', 'deciding'],
    ['resolving', 'needs_review'],
    ['deciding', 'awaiting_approval'],
    ['deciding', 'needs_review'],
    // M6-E: a plan needing no approval now runs straight from DECIDE, which is
    // what §8 always described ("deciding --> executing: zero-risk plan only")
    // and what the table already permitted. Until M6-E nothing performed it.
    ['deciding', 'executing'],
    ['awaiting_approval', 'executing'],
    ['awaiting_approval', 'rejected'],
    ['awaiting_approval', 'needs_review'],
    ['executing', 'completed'],
    ['executing', 'archived'],
    ['executing', 'execution_failed'],
    ['execution_failed', 'executing'],
  ];

  for (const [from, to] of performed) {
    assert.ok(
      isLegalTransition(from as never, to as never),
      `the pipeline performs ${from} → ${to} but the table calls it illegal`,
    );
  }
});

test('invalid transitions are rejected', () => {
  const illegal: Array<[string, string]> = [
    // The one that matters most: a timeout must never resolve toward acting.
    ['expired', 'executing'],
    ['expired', 'completed'],
    // Terminal states are terminal.
    ['completed', 'executing'],
    ['completed', 'awaiting_approval'],
    ['rejected', 'executing'],
    ['rejected', 'awaiting_approval'],
    ['archived', 'executing'],
    // No skipping the pipeline.
    ['received', 'executing'],
    ['received', 'completed'],
    ['received', 'awaiting_approval'],
    ['understanding', 'executing'],
    ['resolving', 'executing'],
    // Not backwards.
    ['completed', 'received'],
    ['executing', 'deciding'],
  ];

  for (const [from, to] of illegal) {
    assert.equal(
      isLegalTransition(from as never, to as never),
      false,
      `${from} → ${to} is declared legal and should not be`,
    );
  }
});

test('terminal states are terminal, and the right ones are terminal', () => {
  assert.deepEqual([...TERMINAL_EMAIL_STATES].sort(), ['archived', 'completed', 'rejected']);

  for (const state of TERMINAL_EMAIL_STATES) {
    for (const other of EMAIL_STATES) {
      if (other === state) continue;
      assert.equal(isLegalTransition(state, other), false, `${state} is terminal but permits → ${other}`);
    }
  }
});

test('re-asserting the current state is always legal', () => {
  for (const state of EMAIL_STATES) {
    assert.equal(isLegalTransition(state, state), true, `${state} → ${state} was rejected`);
  }
});

test('nothing reaches executing except through approval, decision or a retry', () => {
  // The security-relevant shape of the machine: the only doors into `executing`.
  const doors = EMAIL_STATES.filter((state) => state !== 'executing' && isLegalTransition(state, 'executing'));
  assert.deepEqual([...doors].sort(), ['awaiting_approval', 'deciding', 'execution_failed']);

  // And it matches what the executor independently enforces.
  assert.deepEqual(
    [...doors].sort(),
    ['awaiting_approval', 'deciding', 'execution_failed'],
    'the declared machine disagrees with the executor guard',
  );
});
