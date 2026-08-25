// CRM vocabulary and record shapes (FR-34, FR-36).
//
// These types describe the *local* CRM. They are deliberately provider-neutral:
// nothing here mentions HubSpot, and the future HubSpot adapter (§24) maps onto
// these shapes rather than leaking its own. That is what makes §24 an adapter
// rather than a rewrite.

export const CRM_ENTITY_TYPES = ['contact', 'company', 'deal', 'task', 'activity', 'note'] as const;
export type CrmEntityType = (typeof CRM_ENTITY_TYPES)[number];

// Which layer wrote a record. Shown as a badge on every record in the UI
// (§13.6) — an operator should never have to guess whether a human or the
// agent created something.
export const RECORD_SOURCES = ['agent', 'human', 'seed'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export const DEAL_STAGES = [
  'new_lead',
  'qualifying',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const SERVICE_LINES = [
  'ai_customer_support',
  'website_modernization',
  'workflow_automation',
  'ai_recruitment',
  'inbox_lead_management',
  'other',
] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

export const CONTACT_LIFECYCLES = [
  'lead',
  'qualified',
  'customer',
  'partner',
  'vendor',
  'other',
] as const;
export type ContactLifecycle = (typeof CONTACT_LIFECYCLES)[number];

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVITY_TYPES = [
  'email_in',
  'email_out',
  'note',
  'stage_change',
  'task_created',
  'call',
  'meeting',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_DIRECTIONS = ['inbound', 'outbound'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

export type Company = {
  id: string;
  name: string;
  /** Lowercased, legal suffixes stripped. The company match key (FR-13). */
  nameNorm: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeBand: string | null;
  country: string | null;
  source: RecordSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Contact = {
  id: string;
  companyId: string | null;
  fullName: string;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  lifecycle: ContactLifecycle;
  source: RecordSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Deal = {
  id: string;
  companyId: string | null;
  primaryContactId: string | null;
  title: string;
  stage: DealStage;
  serviceLine: ServiceLine | null;
  /** Minor units (cents/paise). Money is never a float. */
  amountMinor: number | null;
  currency: string;
  requirementSummary: string | null;
  budgetNote: string | null;
  timelineNote: string | null;
  expectedCloseDate: string | null;
  source: RecordSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Task = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: TaskStatus;
  priority: 'high' | 'medium' | 'low';
  assignee: string | null;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  emailId: string | null;
  source: RecordSource;
  createdAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

export type Activity = {
  id: string;
  type: ActivityType;
  direction: ActivityDirection | null;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  emailId: string | null;
  source: RecordSource;
  createdAt: string;
  deletedAt: string | null;
};

export type Note = {
  id: string;
  body: string;
  author: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  source: RecordSource;
  createdAt: string;
  deletedAt: string | null;
};

/**
 * Normalises a company name into its match key: lowercase, legal suffixes and
 * punctuation removed, whitespace collapsed. Deterministic and pure, because
 * entity resolution (M2) must give the same answer on every run — a demo whose
 * matching wobbles between runs is worse than no matching at all.
 *
 * Kept here rather than in the M2 resolver because the *seed* data needs it
 * too: `name_norm` is a stored column, so it must be computed identically at
 * write time and at match time. One function, one definition.
 */
const LEGAL_SUFFIXES = [
  'incorporated', 'inc', 'llc', 'ltd', 'limited', 'plc', 'gmbh', 'bv', 'nv',
  'pty', 'pvt', 'private', 'corp', 'corporation', 'co', 'company', 'group',
  'holdings', 'sarl', 'srl', 'ag', 'as', 'ab', 'oy', 'llp',
];

export function normaliseCompanyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(Boolean);
  // Strip trailing legal suffixes only. "Co" leading a name ("Co-op Digital")
  // is part of the name; trailing, it is corporate furniture.
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last !== undefined && LEGAL_SUFFIXES.includes(last)) words.pop();
    else break;
  }
  return words.join(' ');
}

/**
 * Extracts the domain from an email address, lowercased. Returns null for
 * anything that is not a single, well-formed address — callers must handle
 * null rather than receiving a guess.
 */
export function domainFromEmail(email: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email.trim().toLowerCase());
  return match?.[1] ?? null;
}
