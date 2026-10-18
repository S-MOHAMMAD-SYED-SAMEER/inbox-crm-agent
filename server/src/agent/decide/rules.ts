import type { ProposedAction } from '../../domain/actions.ts';
import type { Contact, Deal, DealStage } from '../../domain/crm.ts';
import type { EmailRecord } from '../../domain/email.ts';
import type { Understanding } from '../../domain/understanding.ts';
import type { EntityResolution } from '../../domain/resolution.ts';
import type { EntityRef, RuleTraceEntry } from '../../domain/decision.ts';
import { orderActions } from '../../domain/decision.ts';

// The deterministic business rules.
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
// SPEC PROVENANCE: the action sets come from the specification's stated outcomes for E-01 to
// E-09, not from invention. Where the specification leaves something open, the choice is
// marked DOCUMENTED CHOICE below.

/** Task due dates by priority. 48h for high is the specification's E-01 figure. */
export const TASK_DUE_HOURS: Record<'high' | 'medium' | 'low', number> = {
  high: 48,
  medium: 120,
  low: 240,
};

/**
 * Which stage a follow-up advances a deal to.
 *
 * `qualifying → proposal` is the specification's E-06. The rest follow the same one-step
 * progression through the specification's stage list. `negotiation`, `won` and `lost` have no
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
  /**
   * The most recently updated open deal whose primary contact is the matched contact, if any.
   * Read by R-19, which stops a returning contact from getting a second deal.
   */
  openDealForContact?: Deal | null;
  /** A person looked at this email after it was handed to them and let it continue (the audit log says so). Read only by R-18 and R-20. */
  humanChecked?: boolean;
  /**
   * What a person chose for this email's CRM match, when they were asked (a match conflict): an existing record, or "create new". Absent
   * for a kind nobody was asked about. Read only for an ambiguous email, where R-20 uses it; a pick is the person's decision, a machine
   * match is not.
   */
  humanPick?: { contact?: 'existing' | 'new'; company?: 'existing' | 'new' };
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
  if (ctx.understanding.category === 'ambiguous') return pickedRef(ctx, 'company');
  if (ctx.company.selectedEntityId !== null) return { kind: 'existing', id: ctx.company.selectedEntityId };
  return willCreateCompany(ctx) ? { kind: 'new', ref: 'company' } : null;
}

function contactRef(ctx: DecisionContext): EntityRef | null {
  if (ctx.understanding.category === 'ambiguous') return pickedRef(ctx, 'contact');
  if (ctx.contact.selectedEntityId !== null) return { kind: 'existing', id: ctx.contact.selectedEntityId };
  return willCreateContact(ctx) ? { kind: 'new', ref: 'contact' } : null;
}

/**
 * What an ambiguous email may be filed against: only what a person chose. The reading is unreliable, so a machine match (even an exact
 * one) is not used; a person's pick is. "Existing" is the record they picked, "new" is the record that will be created (built by R-01 or
 * R-02 from fields that passed the verbatim check). Nothing picked, nothing attached.
 */
function pickedRef(ctx: DecisionContext, kind: 'contact' | 'company'): EntityRef | null {
  if (ctx.humanChecked !== true) return null;
  const pick = ctx.humanPick?.[kind];
  const resolution = kind === 'contact' ? ctx.contact : ctx.company;
  if (pick === 'existing' && resolution.selectedEntityId !== null) return { kind: 'existing', id: resolution.selectedEntityId };
  if (createNewChosen(ctx) && pick !== 'existing') return (kind === 'contact' ? willCreateContact(ctx) : willCreateCompany(ctx)) ? { kind: 'new', ref: kind } : null;
  return null;
}

/**
 * Whether a person answered "none of these, create new records". The button says "records", so it covers every kind the CRM has no
 * record of (verdict NO_MATCH): asked which company, "none of these" also means the sender is a new contact. It never covers a kind the
 * person picked an existing record for, and it never covers a kind the machine matched on its own.
 */
function createNewChosen(ctx: DecisionContext): boolean {
  return ctx.humanChecked === true && Object.values(ctx.humanPick ?? {}).includes('new');
}

/** Categories that are archived rather than acted on — noise, by definition. */
const NOISE_CATEGORIES = ['spam', 'vendor_pitch'];

function isNoise(ctx: DecisionContext): boolean {
  return NOISE_CATEGORIES.includes(ctx.understanding.category);
}

/**
 * Whether this email may create a CRM record of this kind.
 *
 * Noise may not. Neither may an *ambiguous* email on the strength of the system's own guess: the specification's E-08 requires "no plan
 * produced", and creating a company and a contact from a reading the system has just declared unreliable would pollute the CRM. The one
 * exception is a person who was asked which record this is, answered "none of these, create new records", and has checked the email:
 * that is their decision, and then (and only then) the record is created, from the same verbatim-checked fields as for any other email.
 * UNDERSTAND normally routes ambiguous emails to review before DECIDE ever sees them; this is the guard for when one arrives anyway.
 */
function producesCrmRecords(ctx: DecisionContext, kind: 'contact' | 'company'): boolean {
  if (isNoise(ctx)) return false;
  if (ctx.understanding.category !== 'ambiguous') return true;
  return createNewChosen(ctx) && ctx.humanPick?.[kind] !== 'existing';
}

/** Why no record of this kind is created for this email, in words that are true for noise and for an ambiguous email alike. */
function noRecordReason(ctx: DecisionContext, kind: 'contact' | 'company'): string {
  if (ctx.understanding.category === 'ambiguous') {
    return ctx.humanPick?.[kind] === 'existing'
      ? `a person picked an existing ${kind}, so a new one is not created`
      : `an ambiguous email creates a ${kind} only when a person has chosen to create one, and no one has`;
  }
  return `${withArticle(plainCategory(ctx))} email never creates a CRM record`;
}

function companyLabel(ctx: DecisionContext): string | null {
  const name = ctx.understanding.extracted.companyName.value;
  const domain = ctx.understanding.extracted.companyDomain.value;
  return name ?? domain ?? null;
}

function willCreateCompany(ctx: DecisionContext): boolean {
  return ctx.company.verdict === 'NO_MATCH' && producesCrmRecords(ctx, 'company') && companyLabel(ctx) !== null;
}

function willCreateContact(ctx: DecisionContext): boolean {
  return ctx.contact.verdict === 'NO_MATCH' && producesCrmRecords(ctx, 'contact');
}

/** "a vendor pitch", "an ambiguous": the article that agrees with the next word. */
function withArticle(words: string): string {
  return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
}

/**
 * The category as the reading is stated: "a vendor pitch", but "ambiguous" and "spam", which are said without an article ("Read as
 * ambiguous", "Read as spam"). The article is chosen here, once, for every category.
 */
function readAs(ctx: DecisionContext): string {
  const words = plainCategory(ctx);
  return ctx.understanding.category === 'ambiguous' || ctx.understanding.category === 'spam' ? words : withArticle(words);
}

function plainCategory(ctx: DecisionContext): string {
  return ctx.understanding.category.replace(/_/g, ' ');
}

function compactName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Why a company is being proposed, in the words that are true. A company named in the message is "named"; one that exists here only
 * because the sender writes from its domain is said to be that, and a bare domain is not called a name.
 */
function normalisedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function companyEvidence(ctx: DecisionContext, label: string): string {
  const named = ctx.understanding.extracted.companyName.value;
  const senderDomain = ctx.email.fromEmail.split('@')[1] ?? '';
  if (named === null) return `no existing company matched and the sender's domain is ${label}`;
  // WHERE THE NAME WAS FOUND, not merely where it could have been. A name that is written in the email (its body, signature, subject or
  // the sender's display name) is "named" by the email even when the sender's domain happens to spell the same thing. Only a name that
  // is NOT written anywhere, and is there because the domain says so, is attributed to the domain.
  const written = normalisedText([ctx.email.fromName ?? '', ctx.email.subject, ctx.email.bodyText].join(' '));
  if (written.includes(normalisedText(named))) return `no existing company matched and the email names "${named}"`;
  const fromDomain = senderDomain.split('.').some((part) => part !== '' && compactName(part) === compactName(named));
  return fromDomain
    ? `no existing company matched, and the sender's domain (${senderDomain}) suggests "${named}"`
    : `no existing company matched and the email names "${named}"`;
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
      // is a judgement about money, and EXECUTE makes it behind the approval gate.
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
      if (!producesCrmRecords(ctx, 'company')) {
        return { fired: false, because: noRecordReason(ctx, 'company') };
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
        because: companyEvidence(ctx, label),
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
      if (!producesCrmRecords(ctx, 'contact')) {
        return { fired: false, because: noRecordReason(ctx, 'contact') };
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
      if (ctx.understanding.category === 'ambiguous') {
        return { fired: false, because: 'an ambiguous email changes no record, and linking two records to each other is a change to both' };
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
      if (!isNoise(ctx)) return { fired: false, because: `the category is ${plainCategory(ctx)}` };
      return {
        fired: true,
        because: `${withArticle(plainCategory(ctx))} email never becomes a lead, so it is archived and no CRM record is created`,
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
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
    description: 'A follow-up on an open deal advances that deal a stage and opens a task for a person to deal with what they asked.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'follow_up') {
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
        because: `an open deal at "${ctx.openDeal.stage}" moves to "${next}" on a follow-up, and a person is given a task to deal with what they asked`,
        actions: [
          activityAction(ctx),
          {
            type: 'update_deal_stage',
            payload: { dealId: ctx.openDeal.id, fromStage: ctx.openDeal.stage, toStage: next },
          },
          // The follow-up usually asks for something (a proposal to sign, an answer). Nothing replies
          // automatically, so a person needs to be told to do it.
          taskAction(ctx, `Prepare and send what they asked for: ${ctx.email.subject}`, ctx.understanding.extracted.requirementSummary.value),
        ],
      };
    },
  },
  {
    id: 'R-13',
    description: 'A follow-up with no open deal becomes an activity and a task.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'follow_up') {
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
      }
      // DOCUMENTED CHOICE: the specification specifies the deal's amount and timeline for
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
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
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
    description: 'An ambiguous email produces no plan at all, until a person has checked it (then R-20).',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'ambiguous') {
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
      }
      if (ctx.humanChecked === true) {
        return { fired: false, because: 'a person has checked this email, so R-20 applies instead' };
      }
      return {
        fired: true,
        because: 'there is nothing definite enough to act on, so a person decides what this is',
        actions: [],
      };
    },
  },
];

// R-20 is the one rule added for the operator's "continue" action on an ambiguous email. Without it a person who checked such an
// email and let it continue would get an empty plan and the email would be handed back to them, which is the dead end the action
// exists to remove. It plans the smallest honest thing: record that the email arrived, and open a task for a person to deal
// with it. It never creates a deal and it never replies, and the plan still needs approval because the reading is still ambiguous.
//
// What the activity and the task are attached to is decided by the person, not by the machine. If they were asked which record this is
// (a match conflict) and picked an existing one, both are attached to it. If they chose "none of these, create new records", R-01 and
// R-02 add the company and/or contact (from fields that passed the verbatim check) and both are attached to those. If they were not
// asked (no conflict), nothing is picked and both are attached to the email only, not even to a record the sender happens to match.
// R-03 never adds a link between two records for an ambiguous email: choosing the records is not a decision to change how they relate.
const humanCheckedRules: Rule[] = [
  {
    id: 'R-20',
    description:
      'An ambiguous email that a person has checked becomes an activity and a task for a person, attached to the record(s) the person picked or chose to create (to the email only when none), never a deal or a reply.',
    evaluate(ctx) {
      if (ctx.understanding.category !== 'ambiguous') {
        return { fired: false, because: `the category is ${plainCategory(ctx)}` };
      }
      if (ctx.humanChecked !== true) {
        return { fired: false, because: 'no person has checked this email yet, so R-18 applies' };
      }
      return {
        fired: true,
        because: `a person checked this ambiguous email and let it continue, so it is logged and given a task for a person${attachedTo(ctx)}`,
        // Attached to what the person picked, and to nothing a machine matched: with no pick, to the EMAIL ONLY (the reading is still
        // ambiguous, so not even a record the sender happens to match).
        actions: [
          {
            type: 'log_activity',
            payload: {
              type: 'email_in',
              subject: ctx.email.subject,
              body: ctx.understanding.summary,
              contact: contactRef(ctx),
              company: companyRef(ctx),
            },
          },
          {
            type: 'create_task',
            payload: {
              title: `Look at this email: ${ctx.email.subject}`,
              description: ctx.understanding.intent,
              dueAt: dueAt(ctx.now, ctx.understanding.priority),
              priority: ctx.understanding.priority,
              contact: contactRef(ctx),
              company: companyRef(ctx),
              deal: null,
            },
          },
        ],
      };
    },
  },
];

/** The sentence fragment that says what a person's pick made R-20 attach to. Empty when nothing was picked. */
function attachedTo(ctx: DecisionContext): string {
  const parts: string[] = [];
  for (const kind of ['contact', 'company'] as const) {
    const pick = ctx.humanPick?.[kind];
    if (pick === 'existing') parts.push(`the ${kind} they picked`);
    if (pick === 'new') parts.push(`a new ${kind}`);
  }
  // "Create new" also covers the kind nobody was asked about, when the CRM has no record of it.
  if (createNewChosen(ctx)) {
    for (const kind of ['contact', 'company'] as const) {
      const resolution = kind === 'contact' ? ctx.contact : ctx.company;
      if (ctx.humanPick?.[kind] === undefined && resolution.verdict === 'NO_MATCH' && pickedRef(ctx, kind) !== null) parts.push(`a new ${kind}`);
    }
  }
  return parts.length === 0 ? '' : `, attached to ${parts.join(' and ')}`;
}

export const RULES: readonly Rule[] = [...entityRules, ...categoryRules, ...humanCheckedRules];

const NEW_DEAL_RULES = ['R-14', 'R-15', 'R-16'];

/**
 * R-19: a NEW deal is never planned for a contact who already has an open one.
 *
 * It runs after the category rules, over the plan they produced, because it exists to correct
 * them: whatever the email was called (a pricing request, a sales inquiry, a service inquiry),
 * if its sender already has an open deal then a second deal for the same person is a duplicate.
 * The new deal is replaced by advancing the existing one a stage (the same step R-12 takes on a
 * follow-up) or, where that deal has no automatic next stage, by nothing: the activity, task and
 * reply the category rule planned stay. The trace says which rule's deal was replaced and why, so
 * "why didn't it create a deal?" has an answer.
 */
function applyExistingDealRule(ctx: DecisionContext, actions: ProposedAction[], trace: RuleTraceEntry[]): ProposedAction[] {
  const description = "A new deal is replaced by the sender's own open deal when they already have one.";
  const existing = ctx.openDealForContact ?? null;
  const planned = actions.findIndex((action) => action.type === 'create_deal');

  if (planned === -1) {
    trace.push({ rule: 'R-19', fired: false, because: 'no new deal was planned, so there is nothing to replace' });
    return actions;
  }
  if (existing === null) {
    trace.push({ rule: 'R-19', fired: false, because: 'the sender has no open deal, so a new one is allowed' });
    return actions;
  }

  const byRule = trace.filter((entry) => entry.fired && NEW_DEAL_RULES.includes(entry.rule)).map((entry) => entry.rule);
  const replaced = byRule.length > 0 ? byRule.join(', ') : 'a category rule';
  const next = STAGE_ADVANCE[existing.stage];
  const rest = actions.filter((_, index) => index !== planned);
  if (next === undefined) {
    trace.push({
      rule: 'R-19',
      fired: true,
      because: `${description} ${replaced} planned a new deal, but the sender already has "${existing.title}" open at "${existing.stage}", which has no automatic next stage, so no deal action is planned`,
    });
    return rest;
  }
  trace.push({
    rule: 'R-19',
    fired: true,
    because: `${description} ${replaced} planned a new deal, but the sender already has "${existing.title}" open at "${existing.stage}", so it moves to "${next}" instead`,
  });
  rest.push({ type: 'update_deal_stage', payload: { dealId: existing.id, fromStage: existing.stage, toStage: next } });
  return rest;
}

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

  return { actions: orderActions(applyExistingDealRule(ctx, actions, trace)), trace };
}

/** A reason as a sentence: a capital first letter and a full stop. The stored text is lower case so it can follow "because". */
export function sentence(reason: string): string {
  const trimmed = reason.trim().replace(/[.]+$/, '');
  return trimmed === '' ? '' : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

/** The operator-facing sentence for a plan. */
export function buildRationale(ctx: DecisionContext, evaluation: RuleEvaluation): string {
  const fired = evaluation.trace.filter((entry) => entry.fired);
  if (evaluation.actions.length === 0) {
    return `No action is recommended: ${fired[fired.length - 1]?.because ?? 'no rule applied to this email'}.`;
  }

  // One sentence for the reading, then one sentence per reason, each starting with a capital letter and ending in a full stop.
  // The reading is stated once; the reasons never repeat it.
  const sentences = fired.map((entry) => sentence(entry.because));
  return (
    `Read as ${readAs(ctx)} (${ctx.understanding.confidenceBand} confidence). ` +
    `${sentences.join(' ')} ` +
    `Rules fired: ${fired.map((entry) => entry.rule).join(', ')}.`
  );
}
