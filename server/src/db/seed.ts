import fs from 'node:fs';
import path from 'node:path';
import { deterministicId } from '../lib/ids.ts';
import { ProblemCollector, requireEmail, requireString, requireOneOf } from '../lib/validate.ts';
import { CONTACT_LIFECYCLES, DEAL_STAGES, SERVICE_LINES, ACTIVITY_TYPES } from '../domain/crm.ts';
import type { Repositories } from './repositories/index.ts';

// Demo CRM seeding (spec §22).
//
// Two properties matter more than the data itself:
//
//   * IDEMPOTENT. Running it twice does not duplicate anything — each record's
//     id is derived from its key, so a second run finds the record already
//     there and skips it. That is what makes `npm run seed` safe to type twice
//     and what lets `npm run reset` be "clear, then seed" rather than a
//     bespoke path.
//   * STABLE. Ids are derived, not random, so a reset restores the same state
//     down to the identifiers. A demo whose record ids change on every reset
//     cannot have a saved link, a screenshot, or a scripted walkthrough.
//
// Every seeded record is written with `source: 'seed'`, so nothing here can
// ever be mistaken for something the agent or a human actually did.

export type SeedCounts = {
  companies: number;
  contacts: number;
  deals: number;
  tasks: number;
  activities: number;
  notes: number;
  skipped: number;
};

type SeedFile = {
  companies: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  deals: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
};

function idFor(kind: string, key: string): string {
  return deterministicId(`${kind}:${key}`);
}

export function parseSeedFile(raw: unknown): SeedFile {
  const problems = new ProblemCollector();
  const record = (raw ?? {}) as Record<string, unknown>;

  const section = (name: keyof SeedFile): Array<Record<string, unknown>> => {
    const value = record[name];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.add(`"${name}" must be an array when present`);
      return [];
    }
    return value as Array<Record<string, unknown>>;
  };

  const file: SeedFile = {
    companies: section('companies'),
    contacts: section('contacts'),
    deals: section('deals'),
    tasks: section('tasks'),
    activities: section('activities'),
    notes: section('notes'),
  };

  // Keys are validated up front because every relationship in the file is
  // expressed through them: a typo'd companyKey would otherwise become a
  // silently orphaned record rather than a loud failure.
  const keys: Record<string, Set<string>> = {};
  for (const [name, rows] of Object.entries(file)) {
    keys[name] = new Set<string>();
    rows.forEach((row, index) => {
      const key = requireString(row.key, `${name}[${index}].key`, problems);
      if (key !== '') {
        if (keys[name]?.has(key)) problems.add(`${name}[${index}]: duplicate key "${key}"`);
        keys[name]?.add(key);
      }
    });
  }

  const requireRef = (
    value: unknown,
    field: string,
    section_: keyof SeedFile,
    optional: boolean,
  ): void => {
    if (value === undefined || value === null) {
      if (!optional) problems.add(`"${field}" is required`);
      return;
    }
    if (typeof value !== 'string' || !keys[section_]?.has(value)) {
      problems.add(`"${field}" references unknown ${section_} key ${JSON.stringify(value)}`);
    }
  };

  file.companies.forEach((row, i) => {
    requireString(row.name, `companies[${i}].name`, problems);
  });

  file.contacts.forEach((row, i) => {
    requireString(row.fullName, `contacts[${i}].fullName`, problems);
    requireEmail(row.email, `contacts[${i}].email`, problems);
    requireRef(row.companyKey, `contacts[${i}].companyKey`, 'companies', true);
    if (row.lifecycle !== undefined) {
      requireOneOf(row.lifecycle, `contacts[${i}].lifecycle`, CONTACT_LIFECYCLES, problems);
    }
  });

  file.deals.forEach((row, i) => {
    requireString(row.title, `deals[${i}].title`, problems);
    requireRef(row.companyKey, `deals[${i}].companyKey`, 'companies', true);
    requireRef(row.primaryContactKey, `deals[${i}].primaryContactKey`, 'contacts', true);
    if (row.stage !== undefined) requireOneOf(row.stage, `deals[${i}].stage`, DEAL_STAGES, problems);
    if (row.serviceLine !== undefined && row.serviceLine !== null) {
      requireOneOf(row.serviceLine, `deals[${i}].serviceLine`, SERVICE_LINES, problems);
    }
  });

  file.tasks.forEach((row, i) => {
    requireString(row.title, `tasks[${i}].title`, problems);
    requireRef(row.contactKey, `tasks[${i}].contactKey`, 'contacts', true);
    requireRef(row.companyKey, `tasks[${i}].companyKey`, 'companies', true);
    requireRef(row.dealKey, `tasks[${i}].dealKey`, 'deals', true);
  });

  file.activities.forEach((row, i) => {
    requireOneOf(row.type, `activities[${i}].type`, ACTIVITY_TYPES, problems);
    requireString(row.occurredAt, `activities[${i}].occurredAt`, problems);
    requireRef(row.contactKey, `activities[${i}].contactKey`, 'contacts', true);
    requireRef(row.companyKey, `activities[${i}].companyKey`, 'companies', true);
    requireRef(row.dealKey, `activities[${i}].dealKey`, 'deals', true);
  });

  file.notes.forEach((row, i) => {
    requireString(row.body, `notes[${i}].body`, problems);
    requireString(row.author, `notes[${i}].author`, problems);
    requireRef(row.contactKey, `notes[${i}].contactKey`, 'contacts', true);
    requireRef(row.companyKey, `notes[${i}].companyKey`, 'companies', true);
    requireRef(row.dealKey, `notes[${i}].dealKey`, 'deals', true);
  });

  problems.throwIfAny('The demo CRM seed file is not valid.');
  return file;
}

export function readSeedFile(dataDir: string): SeedFile {
  const filePath = path.join(dataDir, 'crm-seed.json');
  if (!fs.existsSync(filePath)) throw new Error(`Demo CRM seed file not found at ${filePath}.`);
  return parseSeedFile(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function seedDemoData(repos: Repositories, file: SeedFile): Promise<SeedCounts> {
  const counts: SeedCounts = {
    companies: 0,
    contacts: 0,
    deals: 0,
    tasks: 0,
    activities: 0,
    notes: 0,
    skipped: 0,
  };

  // One transaction for the whole seed: a partially-seeded database is a
  // confusing thing to debug, and "did the seed run?" should have a yes/no
  // answer rather than a percentage.
  // `repos.transaction`, NOT `repos.db.transaction`. Repositories close over
  // the handle they were built with, so writes made through the outer `repos`
  // inside a `repos.db.transaction` block go out on the root handle — the same
  // connection on SQLite, a different pooled client on Postgres. Rebinding them
  // to `tx` is what makes "one transaction for the whole seed" true on both.
  await repos.transaction(async (tx) => {
    for (const row of file.companies) {
      const id = idFor('company', String(row.key));
      if (await tx.companies.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.companies.create({
        id,
        name: String(row.name),
        domain: text(row.domain),
        website: text(row.website),
        industry: text(row.industry),
        sizeBand: text(row.sizeBand),
        country: text(row.country),
        source: 'seed',
      });
      counts.companies++;
    }

    for (const row of file.contacts) {
      const id = idFor('contact', String(row.key));
      if (await tx.contacts.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.contacts.create({
        id,
        companyId: row.companyKey ? idFor('company', String(row.companyKey)) : null,
        fullName: String(row.fullName),
        email: String(row.email),
        phone: text(row.phone),
        jobTitle: text(row.jobTitle),
        ...(row.lifecycle ? { lifecycle: row.lifecycle as 'lead' } : {}),
        source: 'seed',
      });
      counts.contacts++;
    }

    for (const row of file.deals) {
      const id = idFor('deal', String(row.key));
      if (await tx.deals.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.deals.create({
        id,
        companyId: row.companyKey ? idFor('company', String(row.companyKey)) : null,
        primaryContactId: row.primaryContactKey ? idFor('contact', String(row.primaryContactKey)) : null,
        title: String(row.title),
        ...(row.stage ? { stage: row.stage as 'new_lead' } : {}),
        serviceLine: (row.serviceLine ?? null) as null,
        amountMinor: typeof row.amountMinor === 'number' ? row.amountMinor : null,
        ...(row.currency ? { currency: String(row.currency) } : {}),
        requirementSummary: text(row.requirementSummary),
        budgetNote: text(row.budgetNote),
        timelineNote: text(row.timelineNote),
        source: 'seed',
      });
      counts.deals++;
    }

    for (const row of file.tasks) {
      const id = idFor('task', String(row.key));
      if (await tx.tasks.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.tasks.create({
        id,
        title: String(row.title),
        description: text(row.description),
        dueAt: text(row.dueAt),
        ...(row.priority ? { priority: row.priority as 'medium' } : {}),
        contactId: row.contactKey ? idFor('contact', String(row.contactKey)) : null,
        companyId: row.companyKey ? idFor('company', String(row.companyKey)) : null,
        dealId: row.dealKey ? idFor('deal', String(row.dealKey)) : null,
        source: 'seed',
      });
      counts.tasks++;
    }

    for (const row of file.activities) {
      const id = idFor('activity', String(row.key));
      if (await tx.activities.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.activities.create({
        id,
        type: row.type as 'note',
        direction: (row.direction ?? null) as null,
        subject: text(row.subject),
        body: text(row.body),
        occurredAt: String(row.occurredAt),
        contactId: row.contactKey ? idFor('contact', String(row.contactKey)) : null,
        companyId: row.companyKey ? idFor('company', String(row.companyKey)) : null,
        dealId: row.dealKey ? idFor('deal', String(row.dealKey)) : null,
        source: 'seed',
      });
      counts.activities++;
    }

    for (const row of file.notes) {
      const id = idFor('note', String(row.key));
      if (await tx.notes.getById(id)) {
        counts.skipped++;
        continue;
      }
      await tx.notes.create({
        id,
        body: String(row.body),
        author: String(row.author),
        contactId: row.contactKey ? idFor('contact', String(row.contactKey)) : null,
        companyId: row.companyKey ? idFor('company', String(row.companyKey)) : null,
        dealId: row.dealKey ? idFor('deal', String(row.dealKey)) : null,
        source: 'seed',
      });
      counts.notes++;
    }

    await tx.settings.seedDefaults();

    // The demo runs at `assisted`; a new installation stays at `manual`.
    //
    // These are different questions with different right answers. For a client
    // whose inbox this has never seen, `manual` is correct: trust is earned with
    // evidence from their own mail, so everything waits for a person at first.
    // For the demo that is the wrong default — it hides half the product, since
    // nothing ever auto-executes and all ten emails look identical.
    //
    // `assisted` shows both paths in one sitting: the tier-0 emails file
    // themselves, and the consequential ones still stop and ask. Tier 2 is
    // unaffected either way — no autonomy level permits it to run unattended,
    // and that is enforced in `requiresApproval`, not here (§16).
    //
    // `DEFAULT_SETTINGS` is untouched, so a bare `npm run migrate` with no seed
    // still comes up `manual`.
    await tx.settings.set('autonomy_level', 'assisted', 'seed');
  });

  return counts;
}

/**
 * Deletes every row, in reverse dependency order.
 *
 * Only reachable from `npm run reset`, and it says exactly what it is: this is
 * the demo-reset path, not a feature. Nothing in the application — and
 * certainly nothing the agent can reach — can call it.
 */
export async function clearAllData(repos: Repositories): Promise<void> {
  const tables = [
    'audit_events',
    'outbox_messages',
    'action_executions',
    'approvals',
    'decisions',
    'entity_matches',
    'email_analyses',
    'notes',
    'activities',
    'tasks',
    'deals',
    'contacts',
    'companies',
    'emails',
    'settings',
  ];

  await repos.db.transaction(async (tx) => {
    for (const table of tables) await tx.execute(`DELETE FROM ${table}`);
  });
}
