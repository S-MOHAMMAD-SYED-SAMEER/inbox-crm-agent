import { normaliseCompanyName } from '../../domain/crm.ts';
import type { Company, Contact } from '../../domain/crm.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import { distinctiveTokens, emailDomain, normaliseDomain } from './normalise.ts';
import type { ResolutionInput } from './score.ts';

// Candidate generation.
//
// Kept separate from scoring on purpose. This module decides *who is worth
// looking at* — a database concern, driven by indexes. `score.ts` decides *how
// good each one is* — a pure function with no I/O. Mixing the two would put
// matching logic inside a query, where it cannot be unit-tested and cannot be
// explained to anyone.
//
// Generation is deliberately generous: it is cheap to score a candidate and
// reject it, and expensive to never consider the right record at all. Nothing
// here decides anything — a candidate list is a question, not an answer.

export type CandidateSets = {
  contacts: Contact[];
  companies: Company[];
  /** Entities already linked to an earlier email in this thread (spec §7's thread bonus). */
  threadLinkedEntityIds: Set<string>;
};

function dedupeById<T extends { id: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) byId.set(record.id, record);
  // Sorted so the candidate list is identical on every run, whatever order the
  // queries came back in.
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function gatherCandidates(
  repos: Repositories,
  input: ResolutionInput,
): Promise<CandidateSets> {
  const senderDomain = emailDomain(input.senderEmail);
  const extractedDomain = input.extractedCompanyDomain
    ? normaliseDomain(input.extractedCompanyDomain)
    : null;

  // --- companies -----------------------------------------------------------

  const companies: Company[] = [];

  for (const domain of new Set([senderDomain, extractedDomain].filter((d): d is string => d !== null))) {
    const byDomain = await repos.companies.findByDomain(domain);
    if (byDomain) companies.push(byDomain);
  }

  if (input.extractedCompanyName) {
    const nameNorm = normaliseCompanyName(input.extractedCompanyName);
    companies.push(...(await repos.companies.findByNameNorm(nameNorm)));

    // Everything sharing an identifying word. This is what surfaces the
    // near-duplicate pairs a domain lookup alone would miss — and what makes a
    // genuine conflict visible instead of silently creating a second record.
    const tokens = distinctiveTokens(nameNorm);
    if (tokens.length > 0) companies.push(...(await repos.companies.listByNameTokens(tokens)));
  }

  // --- contacts ------------------------------------------------------------

  const contacts: Contact[] = [];

  const exact = await repos.contacts.findByEmail(input.senderEmail);
  if (exact) contacts.push(exact);

  if (senderDomain !== null) {
    contacts.push(...(await repos.contacts.listByEmailDomain(senderDomain)));
  }

  // Colleagues at a company we have already identified: a message can come from
  // a personal address while naming a company we know.
  const uniqueCompanies = dedupeById(companies);
  for (const company of uniqueCompanies) {
    contacts.push(...(await repos.contacts.listByCompany(company.id)));
  }

  // --- thread evidence -----------------------------------------------------

  const threadLinkedEntityIds = new Set<string>();
  if (input.threadId !== null) {
    for (const email of await repos.emails.listByThread(input.threadId)) {
      for (const match of await repos.entityMatches.listSelectedForEmail(email.id)) {
        if (match.entityId !== null) threadLinkedEntityIds.add(match.entityId);
      }
    }
  }

  return { contacts: dedupeById(contacts), companies: uniqueCompanies, threadLinkedEntityIds };
}
