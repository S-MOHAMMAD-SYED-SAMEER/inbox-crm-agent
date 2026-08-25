// The closed action registry (spec §15, FR-21) — the foundation of the
// architecture rule: *the model proposes, deterministic code disposes.*
//
// Two properties of this file carry the entire safety argument:
//
// 1. It is CLOSED. An action the agent can perform must appear here. The
//    model's structured output is validated against this registry before it is
//    anything more than text, so a model that invents `delete_all_deals` does
//    not produce an unknown action — it produces a validation error.
//
// 2. There is NO delete action and NO bulk-update action. Not gated — absent.
//    An agent that cannot express a destructive action cannot be talked into
//    one, which is a stronger guarantee than any permission check, because it
//    holds even if every other layer is wrong. Deletion in this product is
//    soft, human-initiated, and reaches the database through the CRM API, a
//    path the agent has no way to invoke.
//
// Risk tiers drive the approval gate (agent/policy/approval.ts):
//   0 — safe/append-only. May auto-execute when confidence is high.
//   1 — creates a new record. A wrong one is noise, not damage.
//   2 — consequential: money, existing business state, or an irreversible
//       externally-visible side effect. ALWAYS requires a human. No setting
//       anywhere in this system can change that.

export const RISK_TIERS = [0, 1, 2] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const ACTION_TYPES = [
  'log_activity',
  'add_note',
  'create_task',
  'archive_email',
  'create_company',
  'create_contact',
  'link_contact_to_company',
  'create_deal',
  'update_deal_stage',
  'update_deal_amount',
  'send_email',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type ActionDefinition = {
  readonly type: ActionType;
  readonly tier: RiskTier;
  /** Shown verbatim in the Automation screen (§13.7) and in approval reasons. */
  readonly description: string;
  /** Why this tier — the sentence an operator gets when they ask. */
  readonly rationale: string;
  /** Whether executing it can be undone from inside this system. */
  readonly reversible: boolean;
  /** Whether it is visible outside the business (i.e. someone else sees it). */
  readonly externallyVisible: boolean;
};

export const ACTION_REGISTRY: Readonly<Record<ActionType, ActionDefinition>> = Object.freeze({
  log_activity: {
    type: 'log_activity',
    tier: 0,
    description: 'Record an activity on a contact, company, or deal timeline.',
    rationale: 'Append-only history. Nothing existing changes and nothing leaves the business.',
    reversible: true,
    externallyVisible: false,
  },
  add_note: {
    type: 'add_note',
    tier: 0,
    description: 'Attach an internal note to a CRM record.',
    rationale: 'Append-only and internal.',
    reversible: true,
    externallyVisible: false,
  },
  create_task: {
    type: 'create_task',
    tier: 0,
    description: 'Create a follow-up task.',
    rationale: 'Small blast radius: a wrong task is a to-do someone closes.',
    reversible: true,
    externallyVisible: false,
  },
  archive_email: {
    type: 'archive_email',
    tier: 0,
    description: 'Archive an email as noise, creating no CRM record.',
    rationale: 'Affects nothing outside this system, and the email itself is never destroyed.',
    reversible: true,
    externallyVisible: false,
  },
  create_company: {
    type: 'create_company',
    tier: 1,
    description: 'Create a new company record.',
    rationale: 'A new record. A wrong one is noise in the CRM, not damage to business state.',
    reversible: true,
    externallyVisible: false,
  },
  create_contact: {
    type: 'create_contact',
    tier: 1,
    description: 'Create a new contact record.',
    rationale: 'A new record, same reasoning as create_company.',
    reversible: true,
    externallyVisible: false,
  },
  link_contact_to_company: {
    type: 'link_contact_to_company',
    tier: 1,
    description: 'Associate an existing contact with an existing company.',
    rationale: 'Changes an association rather than business state, and is trivially reversible.',
    reversible: true,
    externallyVisible: false,
  },
  create_deal: {
    type: 'create_deal',
    tier: 2,
    description: 'Create a deal in the sales pipeline.',
    rationale: 'Enters the pipeline and changes reported revenue. A human decides what is real.',
    reversible: true,
    externallyVisible: false,
  },
  update_deal_stage: {
    type: 'update_deal_stage',
    tier: 2,
    description: 'Move an existing deal to a different pipeline stage.',
    rationale: 'Mutates existing business state that people make decisions from.',
    reversible: true,
    externallyVisible: false,
  },
  update_deal_amount: {
    type: 'update_deal_amount',
    tier: 2,
    description: 'Change the monetary value of an existing deal.',
    rationale: 'Money. Never automatic.',
    reversible: true,
    externallyVisible: false,
  },
  send_email: {
    type: 'send_email',
    tier: 2,
    description: 'Send a reply to the original sender.',
    rationale:
      'Irreversible and externally visible: once it is sent, the business has said it. ' +
      'This is the action the entire approval workflow exists to protect.',
    reversible: false,
    externallyVisible: true,
  },
});

/**
 * A proposed action. `payload` stays `unknown` at this layer on purpose: per-
 * action payload validation belongs with the DECIDE stage (M3) that builds it
 * and the EXECUTE stage (M4) that applies it. The foundation's job is only to
 * guarantee the *type* is one this system recognises.
 */
export type ProposedAction = {
  type: ActionType;
  payload: unknown;
};

export function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value);
}

export function actionDefinition(type: ActionType): ActionDefinition {
  const definition = ACTION_REGISTRY[type];
  // Unreachable through the type system, but this registry is the safety
  // boundary — if a lookup ever misses, failing loudly is the only acceptable
  // behaviour. Silently treating an unknown action as tier 0 is exactly the
  // bug this file exists to make impossible.
  if (!definition) throw new Error(`No registry entry for action type "${String(type)}".`);
  return definition;
}

export function riskTierOf(type: ActionType): RiskTier {
  return actionDefinition(type).tier;
}

/**
 * A plan's risk tier is the maximum tier of any action in it. A plan is exactly
 * as dangerous as its most dangerous step; averaging or majority-voting would
 * let one `send_email` hide behind four safe actions.
 *
 * An empty plan is tier 0 — it does nothing.
 */
export function planRiskTier(actions: readonly ProposedAction[]): RiskTier {
  let tier: RiskTier = 0;
  for (const action of actions) {
    const actionTier = riskTierOf(action.type);
    if (actionTier > tier) tier = actionTier;
  }
  return tier;
}

export function actionsAtTier(tier: RiskTier): ActionType[] {
  return ACTION_TYPES.filter((type) => ACTION_REGISTRY[type].tier === tier);
}
