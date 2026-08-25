import type { ProposedAction } from '../../domain/actions.ts';
import type { Contact, Deal, DealStage } from '../../domain/crm.ts';
import type { EmailRecord } from '../../domain/email.ts';
import type { Understanding } from '../../domain/understanding.ts';
import type { EntityResolution } from '../../domain/resolution.ts';
import type { EntityRef, RuleTraceEntry } from '../../domain/decision.ts';
import { orderActions } from '../../domain/decision.ts';

// The deterministic business rules (FR-16, FR-19, FR-21).
//
// THIS FILE DECIDES WHAT HAPPENS. THE MODEL DOES NOT.
//
// Every action in a plan comes from a rule here, evaluated over the validated
// understanding, the entity-resolution verdicts and the CRM. No model output
// reaches this code except as *evidence* — a category, a confidence, an
// extracted budget string — and evidence is not authority.
//
// Rules are disjoint by construction rather than first-match-wins: each entity
// rule tests a resolution verdict, each category rule tests one category. That
// keeps the trace honest, because every rule can report why it did *not* fire,
// which is what makes "why didn't it create a deal?" answerable.
//
// SPEC PROVENANCE: the action sets come from §22's stated outcomes for E-01 to
// E-09, not from invention. Where §22 leaves something open, the choice is
// marked DOCUMENTED CHOICE below.

/** Task due dates by priority (FR-30). 48h for high is spec §22's E-01 figure. */
export const TASK_DUE_HOURS: Record<'high' | 'medium' | 'low', number> = {
  high: 48,
  medium: 120,
  low: 240,
};

/**
 * Which stage a follow-up advances a deal to.
 *
 * `qualifying → proposal` is spec §22's E-06. The rest follow the same one-step
 * progression through §7's stage list. `negotiation`, `won` and `lost` have no
 * automatic next step: past negotiation, "they replied" is not evidence of
 * anything in particular, and guessing there would move money.
 */
export const STAGE_ADVANCE: Partial<Record<DealStage, DealStage>> = {
  new_lead: 'qualifying',
  qualifying: 'proposal',
  proposal: 'negotiation',
};

/** Maps what the reader wanted onto the service lines the business actually sells. */
const SERVICE_KEYWORDS: Array<[RegExp, Deal['serviceLine']]> = [
  [/chatbot|customer support|support automation|sales recovery/i, 'ai_customer_support'],
  [/website|site rebuild|redesign|conversion|landing/i, 'website_modernization'],
  [/workflow|onboarding|automat|reporting|process/i, 'workflow_automation'],
  [/recruit|candidate|cv|resume|screening|hiring/i, 'ai_recruitment'],
  [/inbox|lead management|crm/i, 'inbox_lead_management'],
];

export function inferServiceLine(understanding: Understanding): Deal['serviceLine'] {
  const haystack = [
    understanding.extracted.serviceInterest.value,
    understanding.extracted.requirementSummary.value,
    understanding.intent,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  for (const [pattern, line] of SERVICE_KEYWORDS) {
    if (pattern.test(haystack)) return line;
  }
  return 'other';
}

export type DecisionContext = {
  email: EmailRecord;
  understanding: Understanding;
  contact: EntityResolution;
  company: EntityResolution;
  /** The most recently updated open deal on the matched company, if any. */
  openDeal: Deal | null;
  /** The contact record when the contact resolved to a MATCH. Needed by R-03. */
  matchedContact: Contact | null;
  /** Decision time, from the injectable clock — never `new Date()`. */
  now: string;
};

type RuleResult = { fired: boolean; because: string; actions?: ProposedAction[] };

export type Rule = {
  id: string;
  description: string;
  evaluate(ctx: DecisionContext): RuleResult;
};

// ---------------------------------------------------------------- helpers

function companyRef(ctx: DecisionContext): EntityRef | null {
  if (ctx.company.selectedEntityId !== null) return { kind: 'existing', id: ctx.company.selectedEntityId };
  return willCreateCompany(ctx) ? { kind: 'new', ref: 'company' } : null;
}

function contactRef(ctx: DecisionContext): EntityRef | null {
  if (ctx.contact.selectedEntityId !== null) return { kind: 'existing', id: ctx.contact.selectedEntityId };
  return willCreateContact(ctx) ? { kind: 'new', ref: 'contact' } : null;
}

/** Categories that are archived rather than acted on — noise, by definition. */
const NOISE_CATEGORIES = ['spam', 'vendor_pitch'];

function isNoise(ctx: DecisionContext): boolean {
  return NOISE_CATEGORIES.includes(ctx.understanding.category);
}

/**
 * Whether this email may create CRM records at all.
 *
 * Noise obviously may not. Neither may an *ambiguous* email: spec §22's E-08
 * requires "no plan produced", and creating a company and a contact from a
 * reading the system has just declared unreliable would pollute the CRM on the
 * strength of a guess. M1 normally routes these to review before DECIDE ever
 * sees them; this is the guard for when one arrives anyway.
 */
function producesCrmRecords(ctx: DecisionContext): boolean {
  return !isNoise(ctx) && ctx.understanding.category !== 'ambiguous';
}

function companyLabel(ctx: DecisionContext): string | null {
  const name = ctx.understanding.extracted.companyName.value;
  const domain = ctx.understanding.extracted.companyDomain.value;
  return name ?? domain ?? null;
}

function willCreateCompany(ctx: DecisionContext): boolean {
  return ctx.company.verdict === 'NO_MATCH' && producesCrmRecords(ctx) && companyLabel(ctx) !== null;
}

function willCreateContact(ctx: DecisionContext): boolean {
  return ctx.contact.verdict === 'NO_MATCH' && producesCrmRecords(ctx);
}

function dueAt(now: string, priority: 'high' | 'medium' | 'low'): string {
  return new Date(Date.parse(now) + TASK_DUE_HOURS[priority] * 3600_000).toISOString();
}

function senderName(ctx: DecisionContext): string {
  return ctx.understanding.extracted.contactName.value ?? ctx.email.fromName ?? ctx.email.fromEmail;
}

function activityAction(ctx: DecisionContext): ProposedAction {
  return {
    type: 'log_activity',
    payload: {
      type: 'email_in',
      subject: ctx.email.subject,
      // The one-line summary, not the body: an activity is a timeline entry,
      // and copying the message into a second table serves nobody.
      body: ctx.understanding.summary,
      contact: contactRef(ctx),
      company: companyRef(ctx),
    },
  };
}

function taskAction(ctx: DecisionContext, title: string, description: string | null): ProposedAction {
  return {
    type: 'create_task',
    payload: {
      title,
      description,
      dueAt: dueAt(ctx.now, ctx.understanding.priority),
      priority: ctx.understanding.priority,
      contact: contactRef(ctx),
      company: companyRef(ctx),
      deal: null,
    },
  };
}

function dealAction(ctx: DecisionContext, stage: DealStage): ProposedAction {
  const label = companyLabel(ctx) ?? senderName(ctx);
  return {
    type: 'create_deal',
    payload: {
      title: `${label} — ${ctx.understanding.extracted.serviceInterest.value ?? 'new enquiry'}`,
      stage,
      serviceLine: inferServiceLine(ctx.understanding),
      // Verbatim strings, never parsed numbers. Turning "$2-3k" into an amount
      // is a judgement about money, and M4 makes it behind the approval gate.
      budgetNote: ctx.understanding.extracted.budget.value,
      timelineNote: ctx.understanding.extracted.timeline.value,
      requirementSummary: ctx.understanding.extracted.requirementSummary.value,
      company: companyRef(ctx),
      contact: contactRef(ctx),
    },
  };
}

function replyAction(ctx: DecisionContext): ProposedAction {
  return {
    type: 'send_email',
    payload: {
      toEmail: ctx.email.fromEmail,
      inReplyToProviderMessageId: ctx.email.providerMessageId,
    },
  };
}

// ------------------------------------------------------------ entity rules

const entityRules: Rule[] = [
  {
    id: 'R-01',
    description: 'Create the company when the email names one the CRM does not have.',
    evaluate(ctx) {
      if (!producesCrmRecords(ctx)) {
        return {
          fired: false,
          because: `a ${ctx.understanding.category.replace(/_/g, ' ')} email never creates a CRM record`,
        };
      }
      if (ctx.company.verdict !== 'NO_MATCH') {
        return { fired: false, because: `the company resolved as ${ctx.company.verdict}` };
      }
      const label = companyLabel(ctx);
      if (label === null) {
        return { fired: false, because: 'the email does not name a company or a domain' };
      }
      return {
        fired: true,
        because: `no existing company matched and the email names "${label}"`,
        actions: [
          {
            type: 'create_company',
            payload: {
              name: ctx.understanding.extracted.companyName.value ?? label,
              domain: ctx.understanding.extracted.companyDomain.value,
            },
          },
        ],
      };
    },
  },
  {
    id: 'R-02',
    description: 'Create the contact when the sender is not already in the CRM.',
    evaluate(ctx) {
      if (!producesCrmRecords(ctx)) {
        return {
          fired: false,
          because: `a ${ctx.understanding.category.replace(/_/g, ' ')} email never creates a CRM record`,
        };
      }
      if (ctx.contact.verdict !== 'NO_MATCH') {
        return { fired: false, because: `the contact resolved as ${ctx.contact.verdict}` };
      }
      return {
        fired: true,
        because: `no existing contact matched ${ctx.email.fromEmail}`,
        actions: [
          {
            type: 'create_contact',
            payload: {
              fullName: senderName(ctx),
              email: ctx.email.fromEmail,
              jobTitle: ctx.understanding.extracted.jobTitle.value,
              phone: ctx.understanding.extracted.contactPhone.value,
              company: companyRef(ctx),
            },
          },
        ],
      };
    },
  },
  {
    id: 'R-03',
    description: 'Attach a known contact to a known company when the link is missing.',
    evaluate(ctx) {
      if (ctx.contact.verdict !== 'MATCH' || ctx.company.verdict !== 'MATCH') {
        return { fired: false, because: 'both the contact and the company must already exist' };
      }
      if (ctx.contact.selectedEntityId === null || ctx.company.selectedEntityId === null) {
        return { fired: false, because: 'a matched record without an id cannot be linked' };
      }
      if (ctx.matchedContact?.companyId != null) {
        return { fired: false, because: 'the contact is already attached to a company' };
      }
      return {
        fired: true,
        because: 'the contact exists but is not attached to the company this email came from',
        actions: [
          {
            type: 'link_contact_to_company',
            payload: {
              contact: { kind: 'existing', id: ctx.contact.selectedEntityId },
              company: { kind: 'existing', id: ctx.company.selectedEntityId },
            },
          },
        ],
      };
    },
  },
];

// ---------------------------------------------------------- category rules

const categoryRules: Rule[] = [
  {
    id: 'R-10',
    description: 'Noise is archived without creating any CRM record.',
    evaluate(ctx) {
      if (!isNoise(ctx)) return { fired: false, because: `the category is ${ctx.understanding.category}` };
      return {
        fired: true,
        because: `read as ${ctx.understanding.category}, which never becomes a lead`,
        actions: [
          {
            type: 'archive_email',
            payload: { reason: `Filtered as ${ctx.understanding.category}.` },
          },
        ],
      };
    },
  },
  {
    id: 'R-11',
    description: 'A support request becomes a logged activity and a support task, with no reply drafted.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'support_request') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      return {
        fired: true,
        because: 'a support request needs someone to look at it, not a sales reply',
        actions: [
          activityAction(ctx),
          taskAction(
            ctx,
            `Support: ${ctx.email.subject}`,
            ctx.understanding.extracted.requirementSummary.value,
          ),
        ],
      };
    },
  },
  {
    id: 'R-12',
    description: 'A follow-up on an open deal advances that deal a stage.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'follow_up') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      if (ctx.openDeal === null) {
        return { fired: false, because: 'there is no open deal on the matched company' };
      }
      const next = STAGE_ADVANCE[ctx.openDeal.stage];
      if (next === undefined) {
        return {
          fired: false,
          because: `the deal is at "${ctx.openDeal.stage}", which has no automatic next stage`,
        };
      }
      return {
        fired: true,
        because: `an open deal at "${ctx.openDeal.stage}" moves to "${next}" on a follow-up`,
        actions: [
          activityAction(ctx),
          {
            type: 'update_deal_stage',
            payload: { dealId: ctx.openDeal.id, fromStage: ctx.openDeal.stage, toStage: next },
          },
        ],
      };
    },
  },
  {
    id: 'R-13',
    description: 'A follow-up with no open deal becomes an activity and a task.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'follow_up') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      if (ctx.openDeal !== null && STAGE_ADVANCE[ctx.openDeal.stage] !== undefined) {
        return { fired: false, because: 'R-12 is advancing the open deal instead' };
      }
      return {
        fired: true,
        because: 'a follow-up with nothing open still needs a human to pick it up',
        actions: [activityAction(ctx), taskAction(ctx, `Follow up: ${ctx.email.subject}`, null)],
      };
    },
  },
  {
    id: 'R-14',
    description: 'A pricing request becomes a qualifying deal, a task and a drafted reply.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'pricing_request') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      // DOCUMENTED CHOICE: §22 specifies the deal's amount and timeline for
      // E-03 but not its stage. `qualifying` is used because someone stating a
      // budget has, by definition, qualified themselves past a raw lead.
      return {
        fired: true,
        because: 'they asked what it costs, which is a real opportunity and a reply that must not quote a price',
        actions: [
          activityAction(ctx),
          dealAction(ctx, 'qualifying'),
          taskAction(ctx, `Respond with scope and pricing approach: ${ctx.email.subject}`, null),
          replyAction(ctx),
        ],
      };
    },
  },
  {
    id: 'R-15',
    description: 'A sales inquiry becomes a new lead, a follow-up task and a discovery reply.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'sales_inquiry') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      return {
        fired: true,
        because: 'a sales inquiry is a lead worth tracking and answering',
        actions: [
          activityAction(ctx),
          dealAction(ctx, 'new_lead'),
          taskAction(ctx, `Follow up on: ${ctx.email.subject}`, null),
          replyAction(ctx),
        ],
      };
    },
  },
  {
    id: 'R-16',
    description: 'A service inquiry becomes a qualifying deal, a task and a scoping reply.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'service_inquiry') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      return {
        fired: true,
        because: 'a described project is further along than a cold enquiry',
        actions: [
          activityAction(ctx),
          dealAction(ctx, 'qualifying'),
          taskAction(ctx, `Scope the work: ${ctx.email.subject}`, null),
          replyAction(ctx),
        ],
      };
    },
  },
  {
    id: 'R-17',
    description: 'A partnership approach is recorded as a note, with no deal and no auto-reply.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'partnership') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      return {
        fired: true,
        because: 'a partnership is not a sale, so it gets a record but no pipeline entry and no automatic answer',
        actions: [
          activityAction(ctx),
          {
            type: 'add_note',
            payload: {
              body: `Partnership approach: ${ctx.understanding.extracted.requirementSummary.value ?? ctx.understanding.intent}`,
              contact: contactRef(ctx),
              company: companyRef(ctx),
            },
          },
        ],
      };
    },
  },
  {
    id: 'R-18',
    description: 'An ambiguous email produces no plan at all.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'ambiguous') {
        return { fired: false, because: `the category is ${ctx.understanding.category}` };
      }
      return {
        fired: true,
        because: 'there is nothing definite enough to act on, so a person decides what this is',
        actions: [],
      };
    },
  },
];

export const RULES: readonly Rule[] = [...entityRules, ...categoryRules];

export type RuleEvaluation = {
  actions: ProposedAction[];
  trace: RuleTraceEntry[];
};

/**
 * Runs every rule and collects the actions that fired.
 *
 * Every rule is recorded, fired or not. A trace that only lists what happened
 * cannot answer "why didn't it create a deal?", which is the question an
 * operator actually asks when the system surprises them.
 */
export function evaluateRules(ctx: DecisionContext): RuleEvaluation {
  const actions: ProposedAction[] = [];
  const trace: RuleTraceEntry[] = [];

  for (const rule of RULES) {
    const result = rule.evaluate(ctx);
    trace.push({ rule: rule.id, fired: result.fired, because: result.because });
    if (result.fired && result.actions) actions.push(...result.actions);
  }

  return { actions: orderActions(actions), trace };
}

/** The operator-facing sentence for a plan (FR-19, NFR-4). */
export function buildRationale(ctx: DecisionContext, evaluation: RuleEvaluation): string {
  const fired = evaluation.trace.filter((entry) => entry.fired);
  if (evaluation.actions.length === 0) {
    return `No action is recommended: ${fired[fired.length - 1]?.because ?? 'no rule applied to this email'}.`;
  }

  const category = ctx.understanding.category.replace(/_/g, ' ');
  const reasons = fired.map((entry) => entry.because);
  return (
    `Read as a ${category} (${ctx.understanding.confidenceBand} confidence). ` +
    `${reasons.join('; ')}. ` +
    `Rules fired: ${fired.map((entry) => entry.rule).join(', ')}.`
  );
}
