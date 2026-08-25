import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresApproval, canAutoExecute } from '../src/agent/policy/approval.ts';
import { AUTONOMY_LEVELS } from '../src/domain/policy.ts';
import { ACTION_TYPES, ACTION_REGISTRY, actionsAtTier, planRiskTier } from '../src/domain/actions.ts';
import type { ProposedAction } from '../src/domain/actions.ts';

// The most important test file in the project.
//
// NFR-5 is "zero unapproved consequential actions", and a safety property with
// a tolerance is not a safety property. So these tests do not sample: they walk
// every tier-2 action against every autonomy level and assert that approval is
// required in all of them. If someone later adds a `full_autonomy` level or
// moves `send_email` down a tier, this file fails before anything ships.

function action(type: (typeof ACTION_TYPES)[number]): ProposedAction {
  return { type, payload: {} };
}

const HAPPIEST_POSSIBLE_CASE = {
  confidenceBand: 'high' as const,
  flags: { insufficientInformation: false, ambiguousIntent: false, possibleInjection: false },
  hasMatchConflict: false,
  draftGuardrailViolations: [],
  adapterSupportsAtomicity: true,
};

// --- the absolute floor -----------------------------------------------------

test('every tier-2 action requires approval under every autonomy level', () => {
  const tierTwo = actionsAtTier(2);
  assert.ok(tierTwo.length > 0, 'expected the registry to define tier-2 actions');

  for (const type of tierTwo) {
    for (const autonomyLevel of AUTONOMY_LEVELS) {
      const result = requiresApproval({
        ...HAPPIEST_POSSIBLE_CASE,
        actions: [action(type)],
        autonomyLevel,
      });

      assert.equal(
        result.required,
        true,
        `${type} must require approval at autonomy level "${autonomyLevel}" — it did not`,
      );
      assert.equal(result.riskTier, 2);
      assert.ok(
        result.reasons.some((reason) => reason.code === 'consequential_action'),
        `${type} at "${autonomyLevel}" should cite consequential_action`,
      );
    }
  }
});

test('sending an email can never be auto-executed, in the most permissive configuration possible', () => {
  for (const autonomyLevel of AUTONOMY_LEVELS) {
    assert.equal(
      canAutoExecute({ ...HAPPIEST_POSSIBLE_CASE, actions: [action('send_email')], autonomyLevel }),
      false,
    );
  }
});

test('one tier-2 action in a plan of safe actions still forces approval', () => {
  const result = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    actions: [action('log_activity'), action('add_note'), action('create_task'), action('send_email')],
    autonomyLevel: 'autonomous_low_risk',
  });
  assert.equal(result.required, true);
  assert.equal(result.riskTier, 2, 'a plan is as dangerous as its most dangerous action');
});

// --- autonomy levels --------------------------------------------------------

test('manual autonomy requires approval even for a tier-0 plan', () => {
  const result = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    actions: [action('log_activity')],
    autonomyLevel: 'manual',
  });
  assert.equal(result.required, true);
  assert.ok(result.reasons.some((r) => r.code === 'autonomy_level'));
});

test('assisted autonomy auto-executes tier 0 but not tier 1', () => {
  assert.equal(
    canAutoExecute({ ...HAPPIEST_POSSIBLE_CASE, actions: [action('log_activity')], autonomyLevel: 'assisted' }),
    true,
  );
  assert.equal(
    canAutoExecute({ ...HAPPIEST_POSSIBLE_CASE, actions: [action('create_contact')], autonomyLevel: 'assisted' }),
    false,
  );
});

test('autonomous_low_risk auto-executes tier 1 but never tier 2', () => {
  assert.equal(
    canAutoExecute({
      ...HAPPIEST_POSSIBLE_CASE,
      actions: [action('create_contact'), action('create_company')],
      autonomyLevel: 'autonomous_low_risk',
    }),
    true,
  );
  assert.equal(
    canAutoExecute({
      ...HAPPIEST_POSSIBLE_CASE,
      actions: [action('create_deal')],
      autonomyLevel: 'autonomous_low_risk',
    }),
    false,
  );
});

// --- the other six rules ----------------------------------------------------

test('a medium or low confidence band forces approval', () => {
  for (const band of ['medium', 'low'] as const) {
    const result = requiresApproval({
      ...HAPPIEST_POSSIBLE_CASE,
      confidenceBand: band,
      actions: [action('log_activity')],
      autonomyLevel: 'assisted',
    });
    assert.equal(result.required, true);
    assert.ok(result.reasons.some((r) => r.code === 'confidence_not_high'));
  }
});

test('a missing confidence band is treated as unanalysed, not as permission', () => {
  const result = requiresApproval({
    actions: [action('log_activity')],
    autonomyLevel: 'assisted',
    adapterSupportsAtomicity: true,
  });
  assert.equal(result.required, true);
  assert.ok(result.reasons.some((r) => r.code === 'no_understanding'));
});

test('each understanding flag independently forces approval', () => {
  const flags = ['insufficientInformation', 'ambiguousIntent', 'possibleInjection'] as const;
  const expected = { insufficientInformation: 'insufficient_information', ambiguousIntent: 'ambiguous_intent', possibleInjection: 'possible_injection' } as const;

  for (const flag of flags) {
    const result = requiresApproval({
      ...HAPPIEST_POSSIBLE_CASE,
      flags: { [flag]: true },
      actions: [action('log_activity')],
      autonomyLevel: 'assisted',
    });
    assert.equal(result.required, true, `${flag} should force approval`);
    assert.ok(result.reasons.some((r) => r.code === expected[flag]));
  }
});

test('a prompt-injection flag forces approval even for the safest possible plan (D6)', () => {
  const result = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    flags: { possibleInjection: true },
    actions: [action('archive_email')],
    autonomyLevel: 'autonomous_low_risk',
  });
  assert.equal(result.required, true);
  assert.ok(result.reasons.some((r) => r.code === 'possible_injection'));
});

test('a CRM match conflict forces approval', () => {
  const result = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    hasMatchConflict: true,
    actions: [action('log_activity')],
    autonomyLevel: 'assisted',
  });
  assert.equal(result.required, true);
  assert.ok(result.reasons.some((r) => r.code === 'match_conflict'));
});

test('a blocked draft forces approval and names the guardrail', () => {
  const result = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    draftGuardrailViolations: ['no_price_commitment'],
    actions: [action('log_activity')],
    autonomyLevel: 'assisted',
  });
  assert.equal(result.required, true);
  const reason = result.reasons.find((r) => r.code === 'draft_blocked');
  assert.ok(reason);
  assert.match(reason.message, /no_price_commitment/);
});

test('a non-atomic adapter forces approval for multi-action plans only', () => {
  const single = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    adapterSupportsAtomicity: false,
    actions: [action('log_activity')],
    autonomyLevel: 'assisted',
  });
  assert.equal(single.required, false, 'a single action needs no atomicity guarantee');

  const multi = requiresApproval({
    ...HAPPIEST_POSSIBLE_CASE,
    adapterSupportsAtomicity: false,
    actions: [action('log_activity'), action('add_note')],
    autonomyLevel: 'assisted',
  });
  assert.equal(multi.required, true);
  assert.ok(multi.reasons.some((r) => r.code === 'adapter_not_atomic'));
});

// --- reasons are operator-facing -------------------------------------------

test('every reason carries a message a non-technical operator can read', () => {
  const result = requiresApproval({
    confidenceBand: 'low',
    flags: { ambiguousIntent: true },
    hasMatchConflict: true,
    draftGuardrailViolations: ['no_price_commitment'],
    adapterSupportsAtomicity: false,
    actions: [action('send_email'), action('create_deal')],
    autonomyLevel: 'manual',
  });

  assert.ok(result.reasons.length >= 6);
  for (const reason of result.reasons) {
    assert.ok(reason.message.length > 20, `reason ${reason.code} has no usable message`);
    assert.doesNotMatch(reason.message, /undefined|null|\[object/i);
  }
});

// --- the registry itself ----------------------------------------------------

test('the action registry contains no destructive action', () => {
  for (const type of ACTION_TYPES) {
    assert.doesNotMatch(type, /delete|remove|purge|drop|bulk/i, `${type} should not exist in the registry`);
  }
});

test('every action type has a registry entry with a tier and a rationale', () => {
  for (const type of ACTION_TYPES) {
    const definition = ACTION_REGISTRY[type];
    assert.ok(definition, `${type} has no registry entry`);
    assert.equal(definition.type, type);
    assert.ok([0, 1, 2].includes(definition.tier));
    assert.ok(definition.rationale.length > 10, `${type} needs a rationale for its tier`);
  }
});

test('an irreversible, externally visible action is always tier 2', () => {
  for (const type of ACTION_TYPES) {
    const definition = ACTION_REGISTRY[type];
    if (!definition.reversible || definition.externallyVisible) {
      assert.equal(definition.tier, 2, `${type} is irreversible or externally visible and must be tier 2`);
    }
  }
});

test('an empty plan is tier 0', () => {
  assert.equal(planRiskTier([]), 0);
});
