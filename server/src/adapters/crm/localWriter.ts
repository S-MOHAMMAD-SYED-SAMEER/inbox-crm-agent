import type { Repositories } from '../../db/repositories/index.ts';
import type { ProposedAction, ActionType } from '../../domain/actions.ts';
import { ACTION_TYPES } from '../../domain/actions.ts';
import type { EntityRef } from '../../domain/decision.ts';
import type { IdGenerator } from '../../lib/ids.ts';
import { AppError } from '../../lib/errors.ts';
import type { DealStage, ServiceLine } from '../../domain/crm.ts';

// The local CRM writer — the ONLY code in this system that mutates CRM state.
//
// Planning never writes (M3 proved that with a row count). Resolution never
// writes (M2 proved the same). Everything that changes a customer record goes
// through this file, behind the executor's verification, which is what makes
// "could the agent have done this on its own?" answerable with a flat no.
//
// EVERY REGISTRY ACTION HAS AN EXECUTOR OR FAILS CLOSED. The map below is
// checked against the closed registry at startup by `assertEveryActionExecutable`
// and by a test, so an action type can never be added to the registry and then
// silently do nothing — or worse, silently do something unreviewed.

export type ExecutionRefs = {
  /** Ids allocated for `{kind:'new'}` references before anything is written. */
  company: string | null;
  contact: string | null;
};

export type ActionApplication = {
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type WriterContext = {
  repos: Repositories;
  refs: ExecutionRefs;
  emailId: string;
  source: 'agent';
};

function resolveRef(ref: EntityRef | null | undefined, refs: ExecutionRefs): string | null {
  if (!ref) return null;
  if (ref.kind === 'existing') return ref.id;
  // A within-plan reference. The id was allocated before the transaction
  // opened (spec §15 step 1), which is what lets action 3 point at the record
  // action 1 creates without the plan being applied step-by-step.
  return ref.ref === 'company' ? refs.company : refs.contact;
}

function payloadOf<T>(action: ProposedAction): T {
  return (action.payload ?? {}) as T;
}

type Executor = (action: ProposedAction, ctx: WriterContext) => Promise<ActionApplication>;

const EXECUTORS: Record<ActionType, Executor> = {
  create_company: async (action, ctx) => {
    const payload = payloadOf<{ name: string; domain: string | null }>(action);
    const id = ctx.refs.company;
    if (!id) throw new AppError('INTERNAL_ERROR', 'No id was allocated for the company to create.');

    // Duplicate prevention: the plan was made against a snapshot of the CRM,
    // and the world may have moved since. If the domain now exists, link to it
    // rather than creating a second record — a duplicate company is exactly
    // the mess this product claims to prevent.
    if (payload.domain) {
      const existing = await ctx.repos.companies.findByDomain(payload.domain);
      if (existing) {
        ctx.refs.company = existing.id;
        return { targetType: 'company', targetId: existing.id, before: { ...existing }, after: { ...existing } };
      }
    }

    const created = await ctx.repos.companies.create({
      id,
      name: payload.name,
      domain: payload.domain,
      source: ctx.source,
    });
    return { targetType: 'company', targetId: created.id, before: null, after: { ...created } };
  },

  create_contact: async (action, ctx) => {
    const payload = payloadOf<{
      fullName: string;
      email: string;
      jobTitle: string | null;
      phone: string | null;
      company: EntityRef | null;
    }>(action);
    const id = ctx.refs.contact;
    if (!id) throw new AppError('INTERNAL_ERROR', 'No id was allocated for the contact to create.');

    const existing = await ctx.repos.contacts.findByEmail(payload.email);
    if (existing) {
      ctx.refs.contact = existing.id;
      return { targetType: 'contact', targetId: existing.id, before: { ...existing }, after: { ...existing } };
    }

    const created = await ctx.repos.contacts.create({
      id,
      fullName: payload.fullName,
      email: payload.email,
      jobTitle: payload.jobTitle,
      phone: payload.phone,
      companyId: resolveRef(payload.company, ctx.refs),
      source: ctx.source,
    });
    return { targetType: 'contact', targetId: created.id, before: null, after: { ...created } };
  },

  link_contact_to_company: async (action, ctx) => {
    const payload = payloadOf<{ contact: EntityRef; company: EntityRef }>(action);
    const contactId = resolveRef(payload.contact, ctx.refs);
    const companyId = resolveRef(payload.company, ctx.refs);
    if (!contactId || !companyId) throw new AppError('VALIDATION_ERROR', 'The link is missing one of its records.');

    const before = await ctx.repos.contacts.getById(contactId);
    if (!before) throw new AppError('NOT_FOUND', 'The contact to link no longer exists.');

    const after = await ctx.repos.contacts.update(contactId, { companyId });
    return { targetType: 'contact', targetId: contactId, before: { ...before }, after: { ...after } };
  },

  log_activity: async (action, ctx) => {
    const payload = payloadOf<{
      type: 'email_in';
      subject: string;
      body: string;
      contact: EntityRef | null;
      company: EntityRef | null;
    }>(action);

    const created = await ctx.repos.activities.create({
      type: payload.type,
      direction: 'inbound',
      subject: payload.subject,
      body: payload.body,
      contactId: resolveRef(payload.contact, ctx.refs),
      companyId: resolveRef(payload.company, ctx.refs),
      emailId: ctx.emailId,
      source: ctx.source,
    });
    return { targetType: 'activity', targetId: created.id, before: null, after: { ...created } };
  },

  add_note: async (action, ctx) => {
    const payload = payloadOf<{ body: string; contact: EntityRef | null; company: EntityRef | null }>(action);
    const created = await ctx.repos.notes.create({
      body: payload.body,
      author: 'AI Inbox Agent',
      contactId: resolveRef(payload.contact, ctx.refs),
      companyId: resolveRef(payload.company, ctx.refs),
      source: ctx.source,
    });
    return { targetType: 'note', targetId: created.id, before: null, after: { ...created } };
  },

  create_deal: async (action, ctx) => {
    const payload = payloadOf<{
      title: string;
      stage: DealStage;
      serviceLine: ServiceLine | null;
      budgetNote: string | null;
      timelineNote: string | null;
      requirementSummary: string | null;
      company: EntityRef | null;
      contact: EntityRef | null;
    }>(action);

    const created = await ctx.repos.deals.create({
      title: payload.title,
      stage: payload.stage,
      serviceLine: payload.serviceLine,
      // The budget stays a note. Turning "$2-3k" into an amount is a judgement
      // about money, and nothing here is authorised to make it.
      amountMinor: null,
      budgetNote: payload.budgetNote,
      timelineNote: payload.timelineNote,
      requirementSummary: payload.requirementSummary,
      companyId: resolveRef(payload.company, ctx.refs),
      primaryContactId: resolveRef(payload.contact, ctx.refs),
      source: ctx.source,
    });
    return { targetType: 'deal', targetId: created.id, before: null, after: { ...created } };
  },

  update_deal_stage: async (action, ctx) => {
    const payload = payloadOf<{ dealId: string; fromStage: DealStage; toStage: DealStage }>(action);
    const before = await ctx.repos.deals.getById(payload.dealId);
    if (!before) throw new AppError('NOT_FOUND', 'The deal to update no longer exists.');

    // The plan was made against a stage that may since have moved. Applying the
    // transition anyway would overwrite whatever a person did in the meantime.
    if (before.stage !== payload.fromStage) {
      throw new AppError(
        'CONFLICT',
        `This deal is now at "${before.stage}", not "${payload.fromStage}" as when the plan was made.`,
      );
    }

    const after = await ctx.repos.deals.update(payload.dealId, { stage: payload.toStage });
    return { targetType: 'deal', targetId: after.id, before: { ...before }, after: { ...after } };
  },

  update_deal_amount: async (action, ctx) => {
    const payload = payloadOf<{ dealId: string; amountMinor: number; currency?: string }>(action);
    const before = await ctx.repos.deals.getById(payload.dealId);
    if (!before) throw new AppError('NOT_FOUND', 'The deal to update no longer exists.');

    const after = await ctx.repos.deals.update(payload.dealId, {
      amountMinor: payload.amountMinor,
      ...(payload.currency ? { currency: payload.currency } : {}),
    });
    return { targetType: 'deal', targetId: after.id, before: { ...before }, after: { ...after } };
  },

  create_task: async (action, ctx) => {
    const payload = payloadOf<{
      title: string;
      description: string | null;
      dueAt: string;
      priority: 'high' | 'medium' | 'low';
      contact: EntityRef | null;
      company: EntityRef | null;
      deal: EntityRef | null;
    }>(action);

    const created = await ctx.repos.tasks.create({
      title: payload.title,
      description: payload.description,
      dueAt: payload.dueAt,
      priority: payload.priority,
      contactId: resolveRef(payload.contact, ctx.refs),
      companyId: resolveRef(payload.company, ctx.refs),
      emailId: ctx.emailId,
      source: ctx.source,
    });
    return { targetType: 'task', targetId: created.id, before: null, after: { ...created } };
  },

  archive_email: async (_action, ctx) => {
    const before = await ctx.repos.emails.getById(ctx.emailId);
    // Archiving is a state change on the email, applied by the executor after
    // the plan completes — recorded here so the action is not silently a no-op.
    return {
      targetType: 'email',
      targetId: ctx.emailId,
      before: before ? { state: before.state } : null,
      after: { state: 'archived' },
    };
  },

  send_email: async (_action, _ctx) => {
    // Deliberately does nothing here. The outbox row is written by the executor
    // itself, outside the CRM transaction, because it is not a CRM record and
    // because writing it is the one place the "never actually send" boundary
    // has to be enforced in exactly one visible spot.
    return { targetType: 'outbox', targetId: null, before: null, after: null };
  },
};

/**
 * Fails closed if the registry ever gains an action nobody wrote an executor
 * for. Called by the executor before it applies anything.
 */
export function assertEveryActionExecutable(): void {
  const missing = ACTION_TYPES.filter((type) => typeof EXECUTORS[type] !== 'function');
  if (missing.length > 0) {
    throw new AppError(
      'INTERNAL_ERROR',
      `No executor exists for: ${missing.join(', ')}. Refusing to run a plan that contains an unimplemented action.`,
    );
  }
}

export function hasExecutor(type: string): type is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(type) && typeof EXECUTORS[type as ActionType] === 'function';
}

export async function applyAction(action: ProposedAction, ctx: WriterContext): Promise<ActionApplication> {
  const executor = EXECUTORS[action.type];
  if (!executor) {
    throw new AppError('INTERNAL_ERROR', `No executor for action "${action.type}".`);
  }
  return executor(action, ctx);
}

/**
 * Allocates ids for the records a plan will create, before the transaction
 * opens. See `resolveRef` — this is what makes a multi-action plan applicable
 * in one atomic write rather than step by step.
 */
export function allocateRefs(actions: readonly ProposedAction[], newId: IdGenerator): ExecutionRefs {
  return {
    company: actions.some((action) => action.type === 'create_company') ? newId() : null,
    contact: actions.some((action) => action.type === 'create_contact') ? newId() : null,
  };
}
