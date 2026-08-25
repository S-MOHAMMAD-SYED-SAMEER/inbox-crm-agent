// Autonomy vocabulary (spec §16).
//
// An autonomy level says how much the system may do without asking. It has a
// hard floor that no level reaches past: **no level permits a tier-2 action to
// execute without a human.** That is enforced in agent/policy/approval.ts, not
// here — this file only names the levels — but the constraint is written here
// too because this is where someone would come looking to add a fourth level
// called `full_autonomy`. There is deliberately no such level, and adding one
// would fail the test in test/policy.approval.test.ts.

export const AUTONOMY_LEVELS = ['manual', 'assisted', 'autonomous_low_risk'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_DESCRIPTIONS: Readonly<Record<AutonomyLevel, string>> = Object.freeze({
  manual:
    'Everything requires approval, including safe actions. The default for a new client — ' +
    'trust is earned with evidence from their own inbox.',
  assisted:
    'Safe append-only actions run automatically at high confidence. Anything that creates or ' +
    'changes a record requires approval.',
  autonomous_low_risk:
    'Safe actions and new-record creation run automatically at high confidence. Consequential ' +
    'actions — sending email, and anything touching a deal — always require approval.',
});

/**
 * The highest risk tier each level may execute without a human, when every
 * other condition (high confidence, no flags, no conflict) is also satisfied.
 *
 * The value 2 does not appear in this table and must never be added.
 */
export const MAX_AUTO_TIER: Readonly<Record<AutonomyLevel, -1 | 0 | 1>> = Object.freeze({
  manual: -1, // nothing at all runs unattended
  assisted: 0,
  autonomous_low_risk: 1,
});
