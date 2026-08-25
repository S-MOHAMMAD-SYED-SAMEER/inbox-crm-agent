import { planRiskTier, type ProposedAction, type RiskTier } from '../../domain/actions.ts';
import { MAX_AUTO_TIER, type AutonomyLevel } from '../../domain/policy.ts';
import type { ConfidenceBand } from '../../domain/email.ts';

// THE APPROVAL GATE (spec §16, FR-18, NFR-5).
//
// This is the single function that decides whether a human must look at
// something before it happens. Three properties define it:
//
// 1. IT IS PURE AND DETERMINISTIC. Same input, same answer, no I/O, no clock,
//    no model. It can be exhaustively tested, and it will behave in production
//    exactly as it behaves in the test suite.
//
// 2. IT NEVER READS THE MODEL'S OPINION. There is no `modelSaysItIsSafe` field
//    on the input, and there must never be one. Asking a model whether its own
//    proposed action is risky produces an unverifiable claim about precisely
//    the thing this system exists to control — and an email crafted to
//    manipulate the model would be manipulating the safety check itself. What
//    the model produces is *evidence* (a category, a confidence, some flags);
//    what happens next is decided here, in code.
//
// 3. TIER 2 IS AN ABSOLUTE FLOOR. No autonomy level, no setting, no
//    environment variable, and no configuration file lets a tier-2 action —
//    sending an email, creating a deal, changing a deal's stage or amount —
//    execute without a human. This is a product guarantee, and it is asserted
//    both by the invariant check at the bottom of this function and by a test
//    that walks every autonomy level.

export type UnderstandingFlags = {
  insufficientInformation?: boolean;
  ambiguousIntent?: boolean;
  possibleInjection?: boolean;
};

export type ApprovalInput = {
  actions: readonly ProposedAction[];
  autonomyLevel: AutonomyLevel;
  /** Absent means "no understanding yet", which is itself a reason to ask. */
  confidenceBand?: ConfidenceBand;
  flags?: UnderstandingFlags;
  hasMatchConflict?: boolean;
  /** Names of any draft guardrail that blocked the reply (M3). */
  draftGuardrailViolations?: readonly string[];
  /** From the CRM adapter. False forces approval for multi-action plans. */
  adapterSupportsAtomicity?: boolean;
};

export const APPROVAL_REASON_CODES = [
  'consequential_action',
  'confidence_not_high',
  'no_understanding',
  'insufficient_information',
  'ambiguous_intent',
  'possible_injection',
  'match_conflict',
  'draft_blocked',
  'autonomy_level',
  'adapter_not_atomic',
  /**
   * M4-C. Never produced by this function — it is emitted by the revision
   * engine when a human edit recomputes to "no approval needed" but the plan it
   * revises did need one. The requirement is floored at the original's, so
   * editing can raise the bar and never lower it, and this code is how the UI
   * explains a requirement that the current inputs alone would not produce.
   */
  'inherited_from_original',
] as const;
export type ApprovalReasonCode = (typeof APPROVAL_REASON_CODES)[number];

export type ApprovalReason = {
  code: ApprovalReasonCode;
  /** Shown to the operator verbatim (§13.3): states the specific trigger, never "this is risky". */
  message: string;
};

export type ApprovalRequirement = {
  required: boolean;
  riskTier: RiskTier;
  reasons: ApprovalReason[];
};

export function requiresApproval(input: ApprovalInput): ApprovalRequirement {
  const riskTier = planRiskTier(input.actions);
  const reasons: ApprovalReason[] = [];

  // 1. Any tier-2 action, unconditionally.
  if (riskTier === 2) {
    const triggering = input.actions
      .map((action) => action.type)
      .filter((type, index, all) => all.indexOf(type) === index)
      .filter((type) => {
        const single = planRiskTier([{ type, payload: null }]);
        return single === 2;
      });
    reasons.push({
      code: 'consequential_action',
      message:
        `This plan ${triggering.length === 1 ? 'contains an action' : 'contains actions'} that ` +
        `always needs a person: ${triggering.join(', ')}.`,
    });
  }

  // 2. Confidence band. A missing band is treated as worse than a low one:
  //    "we have not established this" is not the same as "we are unsure", and
  //    defaulting the unknown case to permissive would be exactly backwards.
  if (input.confidenceBand === undefined) {
    reasons.push({
      code: 'no_understanding',
      message: 'The email has not been analysed yet, so nothing can run unattended.',
    });
  } else if (input.confidenceBand !== 'high') {
    reasons.push({
      code: 'confidence_not_high',
      message: `The agent's confidence in its reading of this email is ${input.confidenceBand}, not high.`,
    });
  }

  // 3. Any flag raised during UNDERSTAND.
  if (input.flags?.insufficientInformation) {
    reasons.push({
      code: 'insufficient_information',
      message: 'The email does not contain enough information to act on without a person checking.',
    });
  }
  if (input.flags?.ambiguousIntent) {
    reasons.push({
      code: 'ambiguous_intent',
      message: 'The agent could not settle on what this email is asking for.',
    });
  }
  if (input.flags?.possibleInjection) {
    reasons.push({
      code: 'possible_injection',
      message: 'This email contains text that tries to give the agent instructions. A person must review it.',
    });
  }

  // 4. Entity resolution conflict.
  if (input.hasMatchConflict) {
    reasons.push({
      code: 'match_conflict',
      message: 'More than one existing CRM record could be the right match. A person must choose.',
    });
  }

  // 5. Draft guardrails. A blocked draft is never discarded silently — the
  //    operator sees what the agent tried to say and why it was stopped.
  const violations = input.draftGuardrailViolations ?? [];
  if (violations.length > 0) {
    reasons.push({
      code: 'draft_blocked',
      message: `The drafted reply was blocked by ${violations.join(', ')} and needs a person to rewrite or approve it.`,
    });
  }

  // 6. Autonomy level.
  const maxAutoTier = MAX_AUTO_TIER[input.autonomyLevel];
  if (riskTier > maxAutoTier) {
    reasons.push({
      code: 'autonomy_level',
      message:
        input.autonomyLevel === 'manual'
          ? 'Autonomy is set to manual, so every action is approved by a person.'
          : `Autonomy is set to ${input.autonomyLevel}, which does not run this kind of action unattended.`,
    });
  }

  // 7. Adapter atomicity. A multi-action plan on an adapter that cannot apply
  //    it all-or-nothing can fail halfway, and a half-updated CRM is worse
  //    than an un-updated one. (Local: true. HubSpot, when built: false.)
  if (input.adapterSupportsAtomicity === false && input.actions.length > 1) {
    reasons.push({
      code: 'adapter_not_atomic',
      message:
        'The connected CRM cannot apply several changes as one unit, so a multi-step plan needs a person to confirm.',
    });
  }

  const required = reasons.length > 0;

  // Invariant, checked at runtime rather than assumed. If some future edit to
  // the rules above ever lets a tier-2 plan through, this throws instead of
  // sending an email nobody approved. Failing loudly is the correct behaviour
  // for a bug in the safety check itself.
  if (riskTier === 2 && !required) {
    throw new Error(
      'Approval policy invariant violated: a tier-2 plan was not marked as requiring approval. ' +
        'Refusing to proceed.',
    );
  }

  return { required, riskTier, reasons };
}

/** Convenience inverse. Reads better at call sites that gate execution. */
export function canAutoExecute(input: ApprovalInput): boolean {
  return !requiresApproval(input).required;
}
