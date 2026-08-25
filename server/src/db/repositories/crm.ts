import type { Database } from '../types.ts';
import type { Clock } from '../../lib/clock.ts';
import type { IdGenerator } from '../../lib/ids.ts';
import { NotFoundError, ConflictError } from '../../lib/errors.ts';
import { toText, toTextOrNull, toNumberOrNull } from '../rows.ts';
import { buildInsert, buildUpdate, buildTouchUpdate } from './helpers.ts';
import {
  normaliseCompanyName,
  type Activity,
  type Company,
  type Contact,
  type ContactLifecycle,
  type Deal,
  type DealStage,
  type Note,
  type RecordSource,
  type ServiceLine,
  type Task,
  type TaskStatus,
  type ActivityType,
  type ActivityDirection,
} from '../../domain/crm.ts';

// CRM repositories (FR-34, FR-35).
//
// Every repository is a factory taking its dependencies — database, clock, id
// generator — rather than importing a singleton. That is Project 1's pattern
// (`createConversationStore(db)`) and it exists for one reason: a test can hand
// in an in-memory database and a fixed clock and get deterministic results with
// no mocking, no module interception, and no real file on disk.
//
// Two rules hold across all six entities:
//
//   * Reads exclude soft-deleted rows unless explicitly asked. A "deleted"
//     record that keeps appearing in a list is a data-integrity bug the user
//     experiences as the product being broken.
//   * `source` is required on every write. Whether a human or the agent created
//     a record is not metadata here — it is shown on the record (§13.6) and it
//     is what makes the audit trail meaningful.

export type RepoDeps = {
  db: Database;
  clock: Clock;
  newId: IdGenerator;
};

export type ListOptions = { limit?: number; offset?: number; includeDeleted?: boolean };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function limitOf(options: ListOptions): number {
  return Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

// ---------------------------------------------------------------- companies

type CompanyRow = Record<string, unknown>;

function mapCompany(row: CompanyRow): Company {
  return {
    id: toText(row.id),
    name: toText(row.name),
    nameNorm: toText(row.name_norm),
    domain: toTextOrNull(row.domain),
    website: toTextOrNull(row.website),
    industry: toTextOrNull(row.industry),
    sizeBand: toTextOrNull(row.size_band),
    country: toTextOrNull(row.country),
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateCompanyInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeBand?: string | null;
  country?: string | null;
  source: RecordSource;
};

export function createCompanyRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateCompanyInput): Promise<Company> {
      const now = clock.nowIso();
      const domain = input.domain ? input.domain.trim().toLowerCase() : null;

      // Checked before inserting so the caller gets a domain-language error
      // rather than a driver-specific constraint-violation string — the two
      // drivers word that message completely differently.
      if (domain !== null) {
        const existing = await this.findByDomain(domain);
        if (existing) {
          throw new ConflictError(`A company with the domain ${domain} already exists.`, {
            existingId: existing.id,
          });
        }
      }

      const values = {
        id: input.id ?? newId(),
        name: input.name.trim(),
        name_norm: normaliseCompanyName(input.name),
        domain,
        website: input.website ?? null,
        industry: input.industry ?? null,
        size_band: input.sizeBand ?? null,
        country: input.country ?? null,
        source: input.source,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };

      const { sql, params } = buildInsert('companies', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Company;
    },

    async getById(id: string, options: ListOptions = {}): Promise<Company | null> {
      const rows = await db.query<CompanyRow>(
        `SELECT * FROM companies WHERE id = ?${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [id],
      );
      return rows[0] ? mapCompany(rows[0]) : null;
    },

    async findByDomain(domain: string): Promise<Company | null> {
      const rows = await db.query<CompanyRow>(
        'SELECT * FROM companies WHERE domain = ? AND deleted_at IS NULL',
        [domain.trim().toLowerCase()],
      );
      return rows[0] ? mapCompany(rows[0]) : null;
    },

    /**
     * Exact match on the normalised name. Fuzzy matching belongs to the M2
     * resolver — this repository returns facts, not scores.
     */
    async findByNameNorm(name: string): Promise<Company[]> {
      const rows = await db.query<CompanyRow>(
        'SELECT * FROM companies WHERE name_norm = ? AND deleted_at IS NULL ORDER BY created_at',
        [normaliseCompanyName(name)],
      );
      return rows.map(mapCompany);
    },

    /**
     * Companies whose normalised name contains any of the given tokens.
     *
     * Candidate generation for the fuzzy and distinctive-token rules (M2).
     * Scoring happens in `agent/resolve/score.ts`, never here — a repository
     * that decided which company matched would hide the matching logic inside a
     * query, where it could not be unit-tested or explained to a client.
     *
     * `%` and `_` in a token are escaped so a name containing them cannot turn
     * into a wildcard. At demo scale a LIKE scan is right; the Postgres answer
     * at real scale is a pg_trgm GIN index, which is why the similarity function
     * matches pg_trgm's definition exactly (see normalise.ts).
     */
    async listByNameTokens(tokens: readonly string[], options: ListOptions = {}): Promise<Company[]> {
      const cleaned = tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length >= 3);
      if (cleaned.length === 0) return [];

      const clauses = cleaned.map(() => `name_norm LIKE ? ESCAPE '\\'`).join(' OR ');
      const params = cleaned.map((token) => `%${token.replace(/[\\%_]/g, '\\$&')}%`);

      const rows = await db.query<CompanyRow>(
        `SELECT * FROM companies WHERE (${clauses}) AND deleted_at IS NULL
         ORDER BY created_at LIMIT ? OFFSET ?`,
        [...params, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapCompany);
    },

    async list(options: ListOptions = {}): Promise<Company[]> {
      const rows = await db.query<CompanyRow>(
        `SELECT * FROM companies${options.includeDeleted ? '' : ' WHERE deleted_at IS NULL'}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapCompany);
    },

    async update(id: string, patch: Partial<CreateCompanyInput>): Promise<Company> {
      const existing = await this.getById(id);
      if (!existing) throw new NotFoundError('Company');

      const built = buildTouchUpdate('companies', id, {
        name: patch.name?.trim(),
        name_norm: patch.name === undefined ? undefined : normaliseCompanyName(patch.name),
        domain: patch.domain === undefined ? undefined : patch.domain?.trim().toLowerCase() ?? null,
        website: patch.website,
        industry: patch.industry,
        size_band: patch.sizeBand,
        country: patch.country,
      }, clock.nowIso());
      if (built) await db.execute(built.sql, built.params);
      return (await this.getById(id)) as Company;
    },

    /** Soft delete (§11): human-initiated, reversible, and never available to the agent. */
    async softDelete(id: string): Promise<void> {
      const result = await db.execute('UPDATE companies SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) throw new NotFoundError('Company');
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM companies WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// ----------------------------------------------------------------- contacts

function mapContact(row: Record<string, unknown>): Contact {
  return {
    id: toText(row.id),
    companyId: toTextOrNull(row.company_id),
    fullName: toText(row.full_name),
    email: toText(row.email),
    phone: toTextOrNull(row.phone),
    jobTitle: toTextOrNull(row.job_title),
    lifecycle: toText(row.lifecycle) as ContactLifecycle,
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateContactInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  fullName: string;
  email: string;
  companyId?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  lifecycle?: ContactLifecycle;
  source: RecordSource;
};

export function createContactRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateContactInput): Promise<Contact> {
      const now = clock.nowIso();
      const email = input.email.trim().toLowerCase();

      const existing = await this.findByEmail(email);
      if (existing) {
        throw new ConflictError(`A contact with the email address ${email} already exists.`, {
          existingId: existing.id,
        });
      }

      const values = {
        id: input.id ?? newId(),
        company_id: input.companyId ?? null,
        full_name: input.fullName.trim(),
        email,
        phone: input.phone ?? null,
        job_title: input.jobTitle ?? null,
        lifecycle: input.lifecycle ?? 'lead',
        source: input.source,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };

      const { sql, params } = buildInsert('contacts', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Contact;
    },

    async getById(id: string, options: ListOptions = {}): Promise<Contact | null> {
      const rows = await db.query(
        `SELECT * FROM contacts WHERE id = ?${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [id],
      );
      return rows[0] ? mapContact(rows[0]) : null;
    },

    /** The highest-confidence entity-resolution signal there is (FR-12). */
    async findByEmail(email: string): Promise<Contact | null> {
      const rows = await db.query('SELECT * FROM contacts WHERE lower(email) = ? AND deleted_at IS NULL', [
        email.trim().toLowerCase(),
      ]);
      return rows[0] ? mapContact(rows[0]) : null;
    },

    /**
     * Contacts whose email address sits on a given domain.
     *
     * Candidate generation for entity resolution (M2): everyone at the sender's
     * company is a plausible match for a message from that company. The LIKE is
     * anchored to `@domain` so `acme.com` cannot also pull in `notacme.com`.
     */
    async listByEmailDomain(domain: string, options: ListOptions = {}): Promise<Contact[]> {
      const suffix = `%@${domain.trim().toLowerCase()}`;
      const rows = await db.query(
        `SELECT * FROM contacts WHERE lower(email) LIKE ? AND deleted_at IS NULL
         ORDER BY created_at LIMIT ? OFFSET ?`,
        [suffix, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapContact);
    },

    async listByCompany(companyId: string, options: ListOptions = {}): Promise<Contact[]> {
      const rows = await db.query(
        `SELECT * FROM contacts WHERE company_id = ? AND deleted_at IS NULL
         ORDER BY created_at LIMIT ? OFFSET ?`,
        [companyId, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapContact);
    },

    async list(options: ListOptions = {}): Promise<Contact[]> {
      const rows = await db.query(
        `SELECT * FROM contacts${options.includeDeleted ? '' : ' WHERE deleted_at IS NULL'}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapContact);
    },

    async update(id: string, patch: Partial<CreateContactInput>): Promise<Contact> {
      const existing = await this.getById(id);
      if (!existing) throw new NotFoundError('Contact');

      const built = buildTouchUpdate('contacts', id, {
        company_id: patch.companyId,
        full_name: patch.fullName?.trim(),
        email: patch.email?.trim().toLowerCase(),
        phone: patch.phone,
        job_title: patch.jobTitle,
        lifecycle: patch.lifecycle,
      }, clock.nowIso());
      if (built) await db.execute(built.sql, built.params);
      return (await this.getById(id)) as Contact;
    },

    async softDelete(id: string): Promise<void> {
      const result = await db.execute('UPDATE contacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) throw new NotFoundError('Contact');
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// -------------------------------------------------------------------- deals

function mapDeal(row: Record<string, unknown>): Deal {
  return {
    id: toText(row.id),
    companyId: toTextOrNull(row.company_id),
    primaryContactId: toTextOrNull(row.primary_contact_id),
    title: toText(row.title),
    stage: toText(row.stage) as DealStage,
    serviceLine: toTextOrNull(row.service_line) as ServiceLine | null,
    // BIGINT arrives as a string from Postgres and a number from SQLite —
    // see db/rows.ts. Money is stored in minor units so this stays an integer.
    amountMinor: toNumberOrNull(row.amount_minor),
    currency: toText(row.currency),
    requirementSummary: toTextOrNull(row.requirement_summary),
    budgetNote: toTextOrNull(row.budget_note),
    timelineNote: toTextOrNull(row.timeline_note),
    expectedCloseDate: toTextOrNull(row.expected_close_date),
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateDealInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  title: string;
  companyId?: string | null;
  primaryContactId?: string | null;
  stage?: DealStage;
  serviceLine?: ServiceLine | null;
  amountMinor?: number | null;
  currency?: string;
  requirementSummary?: string | null;
  budgetNote?: string | null;
  timelineNote?: string | null;
  expectedCloseDate?: string | null;
  source: RecordSource;
};

export function createDealRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateDealInput): Promise<Deal> {
      const now = clock.nowIso();
      const values = {
        id: input.id ?? newId(),
        company_id: input.companyId ?? null,
        primary_contact_id: input.primaryContactId ?? null,
        title: input.title.trim(),
        stage: input.stage ?? 'new_lead',
        service_line: input.serviceLine ?? null,
        amount_minor: input.amountMinor ?? null,
        currency: input.currency ?? 'USD',
        requirement_summary: input.requirementSummary ?? null,
        budget_note: input.budgetNote ?? null,
        timeline_note: input.timelineNote ?? null,
        expected_close_date: input.expectedCloseDate ?? null,
        source: input.source,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };

      const { sql, params } = buildInsert('deals', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Deal;
    },

    async getById(id: string, options: ListOptions = {}): Promise<Deal | null> {
      const rows = await db.query(
        `SELECT * FROM deals WHERE id = ?${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [id],
      );
      return rows[0] ? mapDeal(rows[0]) : null;
    },

    async list(options: ListOptions & { stage?: DealStage } = {}): Promise<Deal[]> {
      const conditions = options.includeDeleted ? [] : ['deleted_at IS NULL'];
      const params: Array<string | number> = [];
      if (options.stage) {
        conditions.push('stage = ?');
        params.push(options.stage);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.query(
        `SELECT * FROM deals${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        [...params, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapDeal);
    },

    async listByCompany(companyId: string): Promise<Deal[]> {
      const rows = await db.query(
        'SELECT * FROM deals WHERE company_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
        [companyId],
      );
      return rows.map(mapDeal);
    },

    async update(id: string, patch: Partial<CreateDealInput>): Promise<Deal> {
      const existing = await this.getById(id);
      if (!existing) throw new NotFoundError('Deal');

      const built = buildTouchUpdate('deals', id, {
        company_id: patch.companyId,
        primary_contact_id: patch.primaryContactId,
        title: patch.title?.trim(),
        stage: patch.stage,
        service_line: patch.serviceLine,
        amount_minor: patch.amountMinor,
        currency: patch.currency,
        requirement_summary: patch.requirementSummary,
        budget_note: patch.budgetNote,
        timeline_note: patch.timelineNote,
        expected_close_date: patch.expectedCloseDate,
      }, clock.nowIso());
      if (built) await db.execute(built.sql, built.params);
      return (await this.getById(id)) as Deal;
    },

    async softDelete(id: string): Promise<void> {
      const result = await db.execute('UPDATE deals SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) throw new NotFoundError('Deal');
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM deals WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// -------------------------------------------------------------------- tasks

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: toText(row.id),
    title: toText(row.title),
    description: toTextOrNull(row.description),
    dueAt: toTextOrNull(row.due_at),
    status: toText(row.status) as TaskStatus,
    priority: toText(row.priority) as Task['priority'],
    assignee: toTextOrNull(row.assignee),
    contactId: toTextOrNull(row.contact_id),
    companyId: toTextOrNull(row.company_id),
    dealId: toTextOrNull(row.deal_id),
    emailId: toTextOrNull(row.email_id),
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    completedAt: toTextOrNull(row.completed_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateTaskInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  priority?: Task['priority'];
  assignee?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  emailId?: string | null;
  source: RecordSource;
};

export function createTaskRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateTaskInput): Promise<Task> {
      const values = {
        id: input.id ?? newId(),
        title: input.title.trim(),
        description: input.description ?? null,
        due_at: input.dueAt ?? null,
        status: 'open',
        priority: input.priority ?? 'medium',
        assignee: input.assignee ?? null,
        contact_id: input.contactId ?? null,
        company_id: input.companyId ?? null,
        deal_id: input.dealId ?? null,
        email_id: input.emailId ?? null,
        source: input.source,
        created_at: clock.nowIso(),
        completed_at: null,
        deleted_at: null,
      };

      const { sql, params } = buildInsert('tasks', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Task;
    },

    async getById(id: string, options: ListOptions = {}): Promise<Task | null> {
      const rows = await db.query(
        `SELECT * FROM tasks WHERE id = ?${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [id],
      );
      return rows[0] ? mapTask(rows[0]) : null;
    },

    async list(options: ListOptions & { status?: TaskStatus } = {}): Promise<Task[]> {
      const conditions = options.includeDeleted ? [] : ['deleted_at IS NULL'];
      const params: Array<string | number> = [];
      if (options.status) {
        conditions.push('status = ?');
        params.push(options.status);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      // Open tasks with no due date sort last: a task with a deadline is more
      // urgent than one without, and NULL ordering differs between the two
      // engines, so it is made explicit rather than left to the default.
      const rows = await db.query(
        `SELECT * FROM tasks${where} ORDER BY (due_at IS NULL), due_at, created_at LIMIT ? OFFSET ?`,
        [...params, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapTask);
    },

    async complete(id: string): Promise<Task> {
      const now = clock.nowIso();
      const result = await db.execute(
        "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND deleted_at IS NULL",
        [now, id],
      );
      if (result.rowCount === 0) throw new NotFoundError('Task');
      return (await this.getById(id)) as Task;
    },

    async update(id: string, patch: Partial<CreateTaskInput> & { status?: TaskStatus }): Promise<Task> {
      const existing = await this.getById(id);
      if (!existing) throw new NotFoundError('Task');

      const built = buildUpdate('tasks', id, {
        title: patch.title?.trim(),
        description: patch.description,
        due_at: patch.dueAt,
        status: patch.status,
        priority: patch.priority,
        assignee: patch.assignee,
        contact_id: patch.contactId,
        company_id: patch.companyId,
        deal_id: patch.dealId,
      });
      if (built) await db.execute(built.sql, built.params);
      return (await this.getById(id)) as Task;
    },

    async softDelete(id: string): Promise<void> {
      const result = await db.execute('UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) throw new NotFoundError('Task');
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// --------------------------------------------------------------- activities

function mapActivity(row: Record<string, unknown>): Activity {
  return {
    id: toText(row.id),
    type: toText(row.type) as ActivityType,
    direction: toTextOrNull(row.direction) as ActivityDirection | null,
    subject: toTextOrNull(row.subject),
    body: toTextOrNull(row.body),
    occurredAt: toText(row.occurred_at),
    contactId: toTextOrNull(row.contact_id),
    companyId: toTextOrNull(row.company_id),
    dealId: toTextOrNull(row.deal_id),
    emailId: toTextOrNull(row.email_id),
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateActivityInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  type: ActivityType;
  direction?: ActivityDirection | null;
  subject?: string | null;
  body?: string | null;
  occurredAt?: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  emailId?: string | null;
  source: RecordSource;
};

export function createActivityRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateActivityInput): Promise<Activity> {
      const now = clock.nowIso();
      const values = {
        id: input.id ?? newId(),
        type: input.type,
        direction: input.direction ?? null,
        subject: input.subject ?? null,
        body: input.body ?? null,
        occurred_at: input.occurredAt ?? now,
        contact_id: input.contactId ?? null,
        company_id: input.companyId ?? null,
        deal_id: input.dealId ?? null,
        email_id: input.emailId ?? null,
        source: input.source,
        created_at: now,
        deleted_at: null,
      };

      const { sql, params } = buildInsert('activities', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Activity;
    },

    async getById(id: string): Promise<Activity | null> {
      const rows = await db.query('SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL', [id]);
      return rows[0] ? mapActivity(rows[0]) : null;
    },

    /**
     * The unified record timeline (FR-37). One query per entity type rather
     * than a polymorphic join, because the three columns are genuinely
     * different foreign keys and pretending otherwise buys nothing.
     */
    async listForEntity(
      entity: 'contact' | 'company' | 'deal',
      entityId: string,
      options: ListOptions = {},
    ): Promise<Activity[]> {
      const column = entity === 'contact' ? 'contact_id' : entity === 'company' ? 'company_id' : 'deal_id';
      const rows = await db.query(
        `SELECT * FROM activities WHERE ${column} = ? AND deleted_at IS NULL
         ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
        [entityId, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapActivity);
    },

    async listForEmail(emailId: string): Promise<Activity[]> {
      const rows = await db.query(
        'SELECT * FROM activities WHERE email_id = ? AND deleted_at IS NULL ORDER BY occurred_at',
        [emailId],
      );
      return rows.map(mapActivity);
    },

    async list(options: ListOptions = {}): Promise<Activity[]> {
      const rows = await db.query(
        `SELECT * FROM activities WHERE deleted_at IS NULL ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
        [limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapActivity);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM activities WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// -------------------------------------------------------------------- notes

function mapNote(row: Record<string, unknown>): Note {
  return {
    id: toText(row.id),
    body: toText(row.body),
    author: toText(row.author),
    contactId: toTextOrNull(row.contact_id),
    companyId: toTextOrNull(row.company_id),
    dealId: toTextOrNull(row.deal_id),
    source: toText(row.source) as RecordSource,
    createdAt: toText(row.created_at),
    deletedAt: toTextOrNull(row.deleted_at),
  };
}

export type CreateNoteInput = {
  /** Optional explicit id. Used by the seed/import path so ids are stable across resets. */
  id?: string;
  body: string;
  author: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  source: RecordSource;
};

export function createNoteRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateNoteInput): Promise<Note> {
      const values = {
        id: input.id ?? newId(),
        body: input.body,
        author: input.author,
        contact_id: input.contactId ?? null,
        company_id: input.companyId ?? null,
        deal_id: input.dealId ?? null,
        source: input.source,
        created_at: clock.nowIso(),
        deleted_at: null,
      };

      const { sql, params } = buildInsert('notes', values);
      await db.execute(sql, params);
      return (await this.getById(values.id)) as Note;
    },

    async getById(id: string): Promise<Note | null> {
      const rows = await db.query('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL', [id]);
      return rows[0] ? mapNote(rows[0]) : null;
    },

    async listForEntity(
      entity: 'contact' | 'company' | 'deal',
      entityId: string,
      options: ListOptions = {},
    ): Promise<Note[]> {
      const column = entity === 'contact' ? 'contact_id' : entity === 'company' ? 'company_id' : 'deal_id';
      const rows = await db.query(
        `SELECT * FROM notes WHERE ${column} = ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [entityId, limitOf(options), options.offset ?? 0],
      );
      return rows.map(mapNote);
    },

    async softDelete(id: string): Promise<void> {
      const result = await db.execute('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) throw new NotFoundError('Note');
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type CompanyRepository = ReturnType<typeof createCompanyRepository>;
export type ContactRepository = ReturnType<typeof createContactRepository>;
export type DealRepository = ReturnType<typeof createDealRepository>;
export type TaskRepository = ReturnType<typeof createTaskRepository>;
export type ActivityRepository = ReturnType<typeof createActivityRepository>;
export type NoteRepository = ReturnType<typeof createNoteRepository>;
