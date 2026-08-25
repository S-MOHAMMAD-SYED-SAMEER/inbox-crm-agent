import type { ActionType, ProposedAction, RiskTier } from './actions.ts';
import type { ApprovalReason } from '../agent/policy/approval.ts';
import type { DealStage, ServiceLine } from './crm.ts';

// The DECIDE stage's output shape (spec §7 Stage 2, FR-16..FR-21).
//
// THE SPLIT THIS FILE ENCODES
//
// `actions`, `riskTier` and `requiresApproval` are produced by deterministic
// code. `draft` is the only field a model contributes to, and it contributes
// prose — never an action, never a tier, never an approval flag. A drafting
// model that misbehaves produces bad text a human reads before it goes
// anywhere; a planning model that misbehaves produces wrong CRM state. That is
// why the two are different fields with different provenance.

/**
 * How an action refers to a CRM record.
 *
 * A plan is built before anything exists, so `create_contact` may need to point
 * at the company `create_company` will make two steps later. `new` carries a
 * within-plan reference that EXECUTE (M4) resolves to a real id when it applies
 * the plan (spec §15 step 1). Nothing here touches the database.
 */
export type EntityRef =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; ref: 'company' | 'contact' };

export type CreateCompanyPayload = {
  name: string;
  domain: string | null;
};

export type CreateContactPayload = {
  fullName: string;
  email: string;
  jobTitle: string | null;
  phone: string | null;
  company: EntityRef | null;
};

export type LinkContactPayload = {
  contact: EntityRef;
  company: EntityRef;
};

export type CreateDealPayload = {
  title: string;
  stage: DealStage;
  serviceLine: ServiceLine | null;
  /** Verbatim from the email, never a parsed number — M4 decides what to store. */
  budgetNote: string | null;
  timelineNote: string | null;
  requirementSummary: string | null;
  company: EntityRef | null;
  contact: EntityRef | null;
};

export type UpdateDealStagePayload = {
  dealId: string;
  fromStage: DealStage;
  toStage: DealStage;
};

export type CreateTaskPayload = {
  title: string;
  description: string | null;
  dueAt: string;
  priority: 'high' | 'medium' | 'low';
  contact: EntityRef | null;
  company: EntityRef | null;
  deal: EntityRef | null;
};

export type LogActivityPayload = {
  type: 'email_in';
  subject: string;
  body: string;
  contact: EntityRef | null;
  company: EntityRef | null;
};

export type AddNotePayload = {
  body: string;
  contact: EntityRef | null;
  company: EntityRef | null;
};

export type SendEmailPayload = {
  toEmail: string;
  /** The text lives on the plan's `draft`; this action only names the recipient. */
  inReplyToProviderMessageId: string | null;
};

export type ArchiveEmailPayload = {
  reason: string;
};

/** One entry of the machine-readable rule trace (FR-19). */
export type RuleTraceEntry = {
  rule: string;
  fired: boolean;
  /** Why it fired, or why it did not. Both are worth recording. */
  because: string;
};

export type DraftGuardrailViolation = {
  guardrail: string;
  /** The offending text, so an operator sees exactly what was stopped. */
  evidence: string;
  why: string;
};

export type Draft = {
  subject: string;
  body: string;
  /** Names of the guardrails this text satisfied. */
  guardrailsPassed: string[];
  /** Non-empty when the text was blocked. The draft is still shown (§16). */
  blockedBy: DraftGuardrailViolation[];
};

/**
 * The plan (spec §7).
 *
 * `requiresApproval` is a *computed* field, never an input. It is filled from
 * `agent/policy/approval.ts` — the same function M0 built and tested — and
 * nothing in this stage may set it any other way.
 */
export type ActionPlan = {
  actions: ProposedAction[];
  riskTier: RiskTier;
  requiresApproval: boolean;
  approvalReasons: ApprovalReason[];
  rationale: string;
  ruleTrace: RuleTraceEntry[];
  draft: Draft | null;
  /** Set when drafting could not run. Never fails the plan itself. */
  draftFailedReason: string | null;
};

/**
 * Who produced a decision (M4-C).
 *
 * `agent` is the DECIDE stage. `human_edit` is a revision created by a person
 * editing an earlier plan — a *new* decision, never a modification of the one
 * they were shown, because the original proposal paired with the human's
 * version is the labelled signal §20's feedback loop is built on. Editing in
 * place would destroy the more valuable half of it.
 */
export const DECISION_ORIGINS = ['agent', 'human_edit'] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

export type DecisionRecord = {
  id: string;
  emailId: string;
  analysisId: string;
  resolutionRun: string | null;
  plan: ActionPlan;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  /** Set when a later decision replaced this one. History is never rewritten. */
  supersededBy: string | null;
  /**
   * The decision this one was edited from. The backward link, and not derivable
   * from `supersededBy`: an agent re-decide sets that too, and only one of the
   * two has a parent.
   */
  parentDecisionId: string | null;
  /** 1-based position in this email's decision history. */
  revision: number;
  origin: DecisionOrigin;
  /** Who made the edit. Null for anything the agent decided. */
  editedBy: string | null;
  createdAt: string;
};

/** Order actions are applied in, so a plan reads and executes in dependency order. */
export const ACTION_ORDER: readonly ActionType[] = [
  'create_company',
  'create_contact',
  'link_contact_to_company',
  'log_activity',
  'add_note',
  'create_deal',
  'update_deal_stage',
  'update_deal_amount',
  'create_task',
  'archive_email',
  'send_email',
];

export function orderActions(actions: readonly ProposedAction[]): ProposedAction[] {
  return [...actions].sort((a, b) => ACTION_ORDER.indexOf(a.type) - ACTION_ORDER.indexOf(b.type));
}

/**
 * Categories a reply is drafted for.
 *
 * Deliberately short, and taken from spec §22's expected outcomes rather than
 * from intuition: support (E-05) and follow-up (E-06) get no drafted reply, and
 * partnership (E-07) explicitly gets "no auto-reply". Drafting a reply nobody
 * asked for is how an automation starts sounding like a bot.
 */
export const DRAFTABLE_CATEGORIES = ['sales_inquiry', 'service_inquiry', 'pricing_request'] as const;

export function isDraftable(category: string): boolean {
  return (DRAFTABLE_CATEGORIES as readonly string[]).includes(category);
}
