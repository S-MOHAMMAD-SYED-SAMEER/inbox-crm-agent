import { normaliseCompanyName, type Company, type Contact } from '../../domain/crm.ts';
import type { Candidate, MatchMethod } from '../../domain/resolution.ts';
import {
  distinctiveTokens,
  normaliseDomain,
  normaliseEmail,
  normalisePersonName,
  trigramSimilarity,
  emailDomain,
} from './normalise.ts';

// Deterministic candidate scoring (spec §7).
//
// Pure functions over data already in memory. No database, no clock, no model —
// so every rule can be tested in isolation and the same inputs always produce
// the same score.
//
// THE SPEC'S TABLE, IMPLEMENTED EXACTLY:
//
//   Contact                                                score
//     exact email match                                     1.00
//     same domain + normalised name exact                   0.85
//     same domain + normalised name fuzzy (>= 0.85)         0.70
//     name exact, different domain                          0.40
//
//   Company
//     exact domain match                                    1.00
//     normalised name exact (legal suffixes stripped)       0.80
//     normalised name fuzzy (>= 0.88 trigram similarity)    0.65
//
//   Thread
//     prior email in the same thread already linked        +0.20
//
// ONE ADDITION, AND WHY IT WAS NECESSARY
//
// `distinctive_token` (0.65) is not in the spec's table. It was added because
// the spec's own worked example cannot happen without it.
//
// Spec §22 requires E-04 — a message from `mark@harborview-group.invalid` against
// seeded companies *Harborview Digital* and *Harborview Media* — to produce a
// match conflict. Under the table above it produces nothing at all: the domain
// matches neither, and trigram similarity between "harborview group" and
// "harborview digital" is 0.44, far below the 0.88 fuzzy threshold. The rule
// as written would file that email as a brand-new company, silently, which is
// exactly the failure the seeded note about these two businesses warns about.
//
// The gap is that full-string trigram similarity measures how alike two names
// *look*, when what matters is whether they share the word that identifies the
// business. "Harborview" is that word; "Digital", "Media" and "Group" are not.
//
// So: sharing at least one distinctive token — a word that is not on the
// generic list in normalise.ts — scores 0.65, the same as the spec's fuzzy-name
// rule, because it is the same strength of evidence: the names are related but
// not the same. At 0.65 it lands in the conflict band, so it can never
// auto-link on its own; the most it can ever do is put the question in front of
// a person. That is the safe direction to be wrong in, and it is the reason
// this addition does not weaken the guarantees the thresholds provide.

export const SCORES = {
  contactExactEmail: 1.0,
  contactDomainAndExactName: 0.85,
  contactDomainAndFuzzyName: 0.7,
  contactNameOnly: 0.4,
  companyExactDomain: 1.0,
  companyExactNameNorm: 0.8,
  companyFuzzyName: 0.65,
  companyDistinctiveToken: 0.65,
  threadBonus: 0.2,
} as const;

export const SIMILARITY_THRESHOLDS = {
  /** Spec §7: contact name fuzzy match requires >= 0.85. */
  contactName: 0.85,
  /** Spec §7: company name fuzzy match requires >= 0.88. */
  companyName: 0.88,
} as const;

/** What resolution knows about the incoming email, after M1. */
export type ResolutionInput = {
  senderEmail: string;
  senderName: string | null;
  /** From the analysis; may be absent, and absence is not a guess. */
  extractedContactName: string | null;
  extractedContactEmail: string | null;
  extractedCompanyName: string | null;
  extractedCompanyDomain: string | null;
  threadId: string | null;
};

type Signal = { method: MatchMethod; score: number; evidence: string };

function best(signals: Signal[]): Signal | null {
  if (signals.length === 0) return null;
  // Highest score wins; ties break on the earlier (stronger, more specific)
  // rule, because the list is built in the spec's own order.
  return signals.reduce((winner, signal) => (signal.score > winner.score ? signal : winner));
}

/**
 * The address to resolve on.
 *
 * The envelope sender is authoritative, and the extracted address is only used
 * when it agrees. A model that extracted a *different* address — a colleague
 * mentioned in the body, or an address an injected instruction planted — must
 * never redirect resolution onto someone else's record. This is the one place
 * where model output could otherwise steer a link, so it is closed here rather
 * than trusted.
 */
export function resolvableEmail(input: ResolutionInput): string {
  return normaliseEmail(input.senderEmail);
}

// ------------------------------------------------------------------ contact

export function scoreContact(input: ResolutionInput, contact: Contact): Candidate | null {
  const signals: Signal[] = [];

  const senderEmail = resolvableEmail(input);
  const senderDomain = emailDomain(senderEmail);
  const contactEmail = normaliseEmail(contact.email);
  const contactDomain = emailDomain(contactEmail);

  if (contactEmail === senderEmail) {
    signals.push({
      method: 'exact_email',
      score: SCORES.contactExactEmail,
      evidence: `The sender's address ${senderEmail} is this contact's address.`,
    });
  }

  const emailName = normalisePersonName(input.extractedContactName ?? input.senderName ?? '');
  const contactName = normalisePersonName(contact.fullName);
  const sameDomain = senderDomain !== null && contactDomain !== null && senderDomain === contactDomain;

  if (emailName !== '' && contactName !== '') {
    if (sameDomain && emailName === contactName) {
      signals.push({
        method: 'domain_and_exact_name',
        score: SCORES.contactDomainAndExactName,
        evidence: `Same name (${contact.fullName}) at the same domain (${senderDomain}).`,
      });
    } else if (sameDomain) {
      const similarity = trigramSimilarity(emailName, contactName);
      if (similarity >= SIMILARITY_THRESHOLDS.contactName) {
        signals.push({
          method: 'domain_and_fuzzy_name',
          score: SCORES.contactDomainAndFuzzyName,
          evidence: `Similar name (${contact.fullName}, ${similarity.toFixed(2)} similarity) at the same domain (${senderDomain}).`,
        });
      }
    } else if (emailName === contactName) {
      signals.push({
        method: 'name_only',
        score: SCORES.contactNameOnly,
        evidence: `Same name (${contact.fullName}) but a different email domain — weak evidence on its own.`,
      });
    }
  }

  const winner = best(signals);
  if (!winner) return null;

  return {
    entityType: 'contact',
    entityId: contact.id,
    label: `${contact.fullName} <${contact.email}>`,
    score: winner.score,
    method: winner.method,
    evidence: winner.evidence,
    signals,
  };
}

// ------------------------------------------------------------------ company

export function scoreCompany(input: ResolutionInput, company: Company): Candidate | null {
  const signals: Signal[] = [];

  // The sender's own domain counts as company evidence in its own right, and
  // is preferred over the extracted one for the same reason as above.
  const senderDomain = emailDomain(resolvableEmail(input));
  const extractedDomain = input.extractedCompanyDomain
    ? normaliseDomain(input.extractedCompanyDomain)
    : null;
  const companyDomain = company.domain ? normaliseDomain(company.domain) : null;

  if (companyDomain !== null && (companyDomain === senderDomain || companyDomain === extractedDomain)) {
    signals.push({
      method: 'exact_domain',
      score: SCORES.companyExactDomain,
      evidence: `The domain ${companyDomain} belongs to this company.`,
    });
  }

  const emailCompanyNorm = input.extractedCompanyName ? normaliseCompanyName(input.extractedCompanyName) : '';
  const companyNorm = company.nameNorm;

  if (emailCompanyNorm !== '' && companyNorm !== '') {
    if (emailCompanyNorm === companyNorm) {
      signals.push({
        method: 'exact_name_norm',
        score: SCORES.companyExactNameNorm,
        evidence: `The company name in the email matches "${company.name}" once legal suffixes are ignored.`,
      });
    } else {
      const similarity = trigramSimilarity(emailCompanyNorm, companyNorm);
      if (similarity >= SIMILARITY_THRESHOLDS.companyName) {
        signals.push({
          method: 'fuzzy_name',
          score: SCORES.companyFuzzyName,
          evidence: `The company name closely resembles "${company.name}" (${similarity.toFixed(2)} similarity).`,
        });
      } else {
        const shared = distinctiveTokens(emailCompanyNorm).filter((token) =>
          distinctiveTokens(companyNorm).includes(token),
        );
        if (shared.length > 0) {
          signals.push({
            method: 'distinctive_token',
            score: SCORES.companyDistinctiveToken,
            evidence:
              `Shares the distinctive name "${shared.join('", "')}" with "${company.name}", but the domain ` +
              `does not match — related, not necessarily the same business.`,
          });
        }
      }
    }
  }

  const winner = best(signals);
  if (!winner) return null;

  return {
    entityType: 'company',
    entityId: company.id,
    label: company.name,
    score: winner.score,
    method: winner.method,
    evidence: winner.evidence,
    signals,
  };
}

/**
 * Applies the thread bonus (spec §7: +0.20 to an entity already linked in this
 * thread).
 *
 * Capped at 1.00 so a bonus cannot push a score past what an exact match earns
 * — otherwise "we saw this thread before" would outrank "this is literally the
 * same email address", which is backwards.
 *
 * A candidate is never *created* by thread evidence alone. The bonus
 * strengthens a candidate the other rules already found; it does not invent a
 * link, because "we replied to this thread" says nothing about who sent this
 * particular message.
 */
export function applyThreadBonus(candidate: Candidate, linkedEntityIds: ReadonlySet<string>): Candidate {
  if (!linkedEntityIds.has(candidate.entityId)) return candidate;

  const boosted = Math.min(1, Number((candidate.score + SCORES.threadBonus).toFixed(4)));
  const signal = {
    method: 'thread' as const,
    score: SCORES.threadBonus,
    evidence: 'An earlier email in this same thread is already linked to this record.',
  };

  return {
    ...candidate,
    score: boosted,
    evidence: `${candidate.evidence} An earlier email in this thread is already linked to it.`,
    signals: [...candidate.signals, signal],
  };
}

/** Best score first; ties broken by entity id so the order is stable across runs. */
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entityId.localeCompare(b.entityId);
  });
}
