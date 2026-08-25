import { ProblemCollector, optionalOneOf } from '../lib/validate.ts';
import { DEAL_STAGES, TASK_STATUSES } from '../domain/crm.ts';
import type { Company, Contact, Deal, Task } from '../domain/crm.ts';
import type { AuditEvent } from '../domain/audit.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { HandlerResult } from './emails.ts';

// The CRM read layer (M6-C).
//
// READ-ONLY, AND THAT IS THE WHOLE DESIGN.
//
// Every handler here is a GET. There is no create, no update, no delete and no
// endpoint that changes anything — the only thing permitted to write to the CRM
// is the executor, after an approval, through the closed action registry (§15).
// A "quick edit this deal" endpoint would be a second write path into exactly
// the state the approval workflow exists to protect, so there is not one.
//
// WHY THESE EXIST AT ALL
//
// Spec §11 describes CRM endpoints; nothing had built them. The agent has been
// creating companies, contacts, deals and tasks since M4-A, and the only place
// any of it was visible was the execution list on the email that made it. The
// screens could not exist without these, and these are a thin projection over
// repositories that were already complete.
//
// ENRICHMENT HAPPENS HERE, NOT IN THE BROWSER
//
// A deal stores `companyId`; a person wants the company's name. Resolving that
// per row would be an N+1, and doing it in the frontend would put a join in a
// React component. Each handler fetches the related sets once and maps them —
// three queries for a screen, whatever the row count.

export type CrmDeps = Pick<Repositories, 'companies' | 'contacts' | 'deals' | 'tasks' | 'activities' | 'audit'>;

/**
 * A whole number from a query string.
 *
 * `optionalInteger` in lib/validate rejects anything that is not already a
 * number, which is right for a JSON body and wrong here: Express hands every
 * query parameter over as a string, so `?limit=50` arrives as `'50'`. Parsing
 * belongs at this edge rather than loosening a validator the request bodies
 * depend on being strict.
 */
function numericParam(
  value: unknown,
  field: string,
  problems: ProblemCollector,
  bounds: { min: number; max: number },
): number | null {
  if (value === undefined || value === null || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isInteger(parsed)) {
    problems.add(`"${field}" must be a whole number`);
    return null;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    problems.add(`"${field}" must be between ${bounds.min} and ${bounds.max}`);
    return null;
  }
  return parsed;
}

/** Page limits mirror the repositories' own caps. */
function paging(query: Record<string, unknown>, problems: ProblemCollector): { limit: number; offset: number } {
  const limit = numericParam(query.limit, 'limit', problems, { min: 1, max: 200 }) ?? 100;
  const offset = numericParam(query.offset, 'offset', problems, { min: 0, max: 100_000 }) ?? 0;
  return { limit, offset };
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

// --------------------------------------------------------------------- deals

export type DealRow = Deal & {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export async function handleListDeals(
  deps: CrmDeps,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ deals: DealRow[]; total: number }>> {
  const problems = new ProblemCollector();
  const stage = optionalOneOf(query.stage, 'stage', DEAL_STAGES, problems);
  const { limit, offset } = paging(query, problems);
  problems.throwIfAny();

  const deals = await deps.deals.list({ limit, offset, ...(stage ? { stage } : {}) });
  const companies = byId(await deps.companies.list({ limit: 200 }));
  const contacts = byId(await deps.contacts.list({ limit: 200 }));

  return {
    status: 200,
    body: {
      deals: deals.map((deal) => ({
        ...deal,
        companyName: deal.companyId ? (companies.get(deal.companyId)?.name ?? null) : null,
        contactName: deal.primaryContactId ? (contacts.get(deal.primaryContactId)?.fullName ?? null) : null,
        contactEmail: deal.primaryContactId ? (contacts.get(deal.primaryContactId)?.email ?? null) : null,
      })),
      total: await deps.deals.count(),
    },
  };
}

// ------------------------------------------------------------------ contacts

export type ContactRow = Contact & {
  companyName: string | null;
  /** How many timeline entries this contact has. Cheap signal of activity. */
  activityCount: number;
};

export async function handleListContacts(
  deps: CrmDeps,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ contacts: ContactRow[]; total: number }>> {
  const problems = new ProblemCollector();
  const { limit, offset } = paging(query, problems);
  problems.throwIfAny();

  const contacts = await deps.contacts.list({ limit, offset });
  const companies = byId(await deps.companies.list({ limit: 200 }));

  // One pass over the activity page rather than a query per contact.
  const activities = await deps.activities.list({ limit: 500 });
  const counts = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.contactId) continue;
    counts.set(activity.contactId, (counts.get(activity.contactId) ?? 0) + 1);
  }

  return {
    status: 200,
    body: {
      contacts: contacts.map((contact) => ({
        ...contact,
        companyName: contact.companyId ? (companies.get(contact.companyId)?.name ?? null) : null,
        activityCount: counts.get(contact.id) ?? 0,
      })),
      total: await deps.contacts.count(),
    },
  };
}

// ----------------------------------------------------------------- companies

export type CompanyRow = Company & {
  contactCount: number;
  dealCount: number;
};

export async function handleListCompanies(
  deps: CrmDeps,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ companies: CompanyRow[]; total: number }>> {
  const problems = new ProblemCollector();
  const { limit, offset } = paging(query, problems);
  problems.throwIfAny();

  const companies = await deps.companies.list({ limit, offset });
  const contacts = await deps.contacts.list({ limit: 200 });
  const deals = await deps.deals.list({ limit: 200 });

  const contactCounts = new Map<string, number>();
  for (const contact of contacts) {
    if (!contact.companyId) continue;
    contactCounts.set(contact.companyId, (contactCounts.get(contact.companyId) ?? 0) + 1);
  }

  const dealCounts = new Map<string, number>();
  for (const deal of deals) {
    if (!deal.companyId) continue;
    dealCounts.set(deal.companyId, (dealCounts.get(deal.companyId) ?? 0) + 1);
  }

  return {
    status: 200,
    body: {
      companies: companies.map((company) => ({
        ...company,
        contactCount: contactCounts.get(company.id) ?? 0,
        dealCount: dealCounts.get(company.id) ?? 0,
      })),
      total: await deps.companies.count(),
    },
  };
}

// --------------------------------------------------------------------- tasks

export type TaskRow = Task & {
  companyName: string | null;
  contactName: string | null;
  dealTitle: string | null;
};

export async function handleListTasks(
  deps: CrmDeps,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ tasks: TaskRow[]; total: number }>> {
  const problems = new ProblemCollector();
  const status = optionalOneOf(query.status, 'status', TASK_STATUSES, problems);
  const { limit, offset } = paging(query, problems);
  problems.throwIfAny();

  const tasks = await deps.tasks.list({ limit, offset, ...(status ? { status } : {}) });
  const companies = byId(await deps.companies.list({ limit: 200 }));
  const contacts = byId(await deps.contacts.list({ limit: 200 }));
  const deals = byId(await deps.deals.list({ limit: 200 }));

  return {
    status: 200,
    body: {
      tasks: tasks.map((task) => ({
        ...task,
        companyName: task.companyId ? (companies.get(task.companyId)?.name ?? null) : null,
        contactName: task.contactId ? (contacts.get(task.contactId)?.fullName ?? null) : null,
        dealTitle: task.dealId ? (deals.get(task.dealId)?.title ?? null) : null,
      })),
      total: await deps.tasks.count(),
    },
  };
}

// --------------------------------------------------------------------- audit

/**
 * One audit event, as it may be shown.
 *
 * The payload is deliberately NOT included.
 *
 * It is bounded and identifier-safe (M5-F), but it is written for an operator
 * reading one email's trail with the email in front of them — not for a
 * system-wide list where a stray field could surface out of context. The list
 * shows what happened, when, who did it and how it ended; the full payload
 * stays on the email's own page, where it already is. Message bodies are never
 * in it either way (§19), and this keeps that true by construction rather than
 * by review.
 */
export type AuditRow = {
  id: string;
  correlationId: string;
  emailId: string | null;
  sequence: number;
  stage: AuditEvent['stage'];
  eventType: AuditEvent['eventType'];
  actor: AuditEvent['actor'];
  actorId: string | null;
  outcome: AuditEvent['outcome'];
  summary: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export async function handleListAudit(
  deps: CrmDeps,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ events: AuditRow[]; total: number }>> {
  const problems = new ProblemCollector();
  const actor = optionalOneOf(query.actor, 'actor', ['system', 'ai', 'human'] as const, problems);
  const outcome = optionalOneOf(query.outcome, 'outcome', ['ok', 'blocked', 'failed', 'skipped'] as const, problems);
  const { limit, offset } = paging(query, problems);
  problems.throwIfAny();

  const events = await deps.audit.list({
    limit,
    offset,
    ...(actor ? { actor } : {}),
    ...(outcome ? { outcome } : {}),
  });

  return {
    status: 200,
    body: {
      events: events.map((event) => ({
        id: event.id,
        correlationId: event.correlationId,
        emailId: event.emailId,
        sequence: event.sequence,
        stage: event.stage,
        eventType: event.eventType,
        actor: event.actor,
        actorId: event.actorId,
        outcome: event.outcome,
        summary: event.summary,
        entityType: event.entityType,
        entityId: event.entityId,
        createdAt: event.createdAt,
      })),
      total: await deps.audit.count(),
    },
  };
}
