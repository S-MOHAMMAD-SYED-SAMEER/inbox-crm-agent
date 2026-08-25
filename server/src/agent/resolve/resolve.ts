import { gatherCandidates } from './candidates.ts';
import { applyThreadBonus, rankCandidates, scoreCompany, scoreContact, type ResolutionInput } from './score.ts';
import {
  RESOLUTION_THRESHOLDS,
  resolutionVerdict,
  type Candidate,
  type EntityResolution,
  type ResolutionRecord,
  type ResolvableEntityType,
} from '../../domain/resolution.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import type { EmailRecord, ReviewReason } from '../../domain/email.ts';
import type { AnalysisRecord } from '../../domain/understanding.ts';
import { AppError } from '../../lib/errors.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { newId as defaultNewId } from '../../lib/ids.ts';

// ENTITY RESOLUTION (spec §7, between stages 1 and 2).
//
// Deterministic from end to end. No model call happens here, and no model
// output can override a verdict — the analysis contributes *evidence* (a
// company name, a domain), and code decides what that evidence is worth.
//
// M2 WRITES NOTHING TO THE CRM. Resolution answers "which record is this?"; it
// never creates or changes one. A NO_MATCH result is a *proposal* to create,
// which M3 turns into an action and M4 executes behind the approval gate. That
// separation is why this stage can run automatically at all.
//
// The email leaves this stage in one of two states:
//
//   deciding      — resolved (matched, or cleanly new); ready for DECIDE (M3).
//   needs_review  — a human must choose, with reason `match_conflict`.

export type ResolutionOutcomeSummary = {
  email: EmailRecord;
  contact: EntityResolution;
  company: EntityResolution;
  resolutionRun: string;
  state: EmailRecord['state'];
  reviewReason: ReviewReason | null;
};

export type ResolveDeps = {
  repos: Repositories;
  logger?: Logger;
  newId?: () => string;
};

/**
 * Turns a ranked candidate list into a verdict (FR-15).
 *
 * The three rules, in the order they are checked:
 *
 *   1. Two candidates within 0.10 of each other → CONFLICT. Checked FIRST, so a
 *      tie at the top can never be resolved by "well, one of them cleared the
 *      threshold". Two records that are equally good matches are not a match;
 *      they are a question.
 *   2. Top score >= 0.80 → MATCH.
 *   3. Top score < 0.50 → NO_MATCH; anything in between → CONFLICT.
 *
 * Note what rule 3 means: a lone candidate scoring 0.65 does NOT become a match
 * for lack of competition. Being the only candidate is not evidence.
 */
export function decideOutcome(entityType: ResolvableEntityType, ranked: Candidate[]): EntityResolution {
  const base = { entityType, candidates: ranked };

  const top = ranked[0];
  if (!top) {
    return {
      ...base,
      outcome: 'propose_create',
      verdict: 'NO_MATCH',
      selectedEntityId: null,
      reason: `No existing ${entityType} in the CRM matched this email, so this looks like a new record.`,
    };
  }

  const runnerUp = ranked[1];
  if (runnerUp && top.score - runnerUp.score <= RESOLUTION_THRESHOLDS.conflictWindow) {
    return {
      ...base,
      outcome: 'conflict',
      verdict: 'MATCH_CONFLICT',
      selectedEntityId: null,
      reason:
        `Two ${entityType} records are equally plausible — "${top.label}" (${top.score.toFixed(2)}) and ` +
        `"${runnerUp.label}" (${runnerUp.score.toFixed(2)}). A person needs to choose; nothing has been linked.`,
    };
  }

  if (top.score >= RESOLUTION_THRESHOLDS.autoLink) {
    return {
      ...base,
      outcome: 'auto_linked',
      verdict: 'MATCH',
      selectedEntityId: top.entityId,
      reason: `Linked to "${top.label}" — ${top.evidence}`,
    };
  }

  if (top.score < RESOLUTION_THRESHOLDS.proposeCreate) {
    return {
      ...base,
      outcome: 'propose_create',
      verdict: 'NO_MATCH',
      selectedEntityId: null,
      reason:
        `The closest ${entityType}, "${top.label}", scored only ${top.score.toFixed(2)} — too weak to link, ` +
        `so this looks like a new record.`,
    };
  }

  return {
    ...base,
    outcome: 'conflict',
    verdict: 'MATCH_CONFLICT',
    selectedEntityId: null,
    reason:
      `"${top.label}" is a possible match at ${top.score.toFixed(2)}, but not strong enough to link ` +
      `automatically. A person needs to confirm it.`,
  };
}

/**
 * Builds the resolver's input from the email and its analysis.
 *
 * The envelope sender always wins over anything extracted — see
 * `resolvableEmail` in score.ts for why that matters. Extracted values are used
 * only where they add information the envelope does not carry.
 */
export function buildResolutionInput(email: EmailRecord, analysis: AnalysisRecord | null): ResolutionInput {
  const extracted = analysis?.understanding.extracted;
  return {
    senderEmail: email.fromEmail,
    senderName: email.fromName,
    extractedContactName: extracted?.contactName.value ?? null,
    extractedContactEmail: extracted?.contactEmail.value ?? null,
    extractedCompanyName: extracted?.companyName.value ?? null,
    extractedCompanyDomain: extracted?.companyDomain.value ?? null,
    threadId: email.threadId,
  };
}

/**
 * Cross-checks the two verdicts against each other.
 *
 * A contact linked to company A while the email's domain says company B is
 * contradictory evidence, not a match. It usually means the person has moved,
 * or that two records share a name — either way a human should look, because
 * writing the enquiry onto the wrong company is invisible once it happens.
 */
function detectCrossConflict(
  repos: Repositories,
  contact: EntityResolution,
  company: EntityResolution,
): Promise<string | null> {
  if (contact.selectedEntityId === null || company.selectedEntityId === null) return Promise.resolve(null);

  return repos.contacts.getById(contact.selectedEntityId).then((linkedContact) => {
    if (!linkedContact || linkedContact.companyId === null) return null;
    if (linkedContact.companyId === company.selectedEntityId) return null;
    return (
      'The matched contact belongs to a different company than the one this email points at. ' +
      'A person should confirm which is right before anything is linked.'
    );
  });
}

export async function resolveEmail(
  email: EmailRecord,
  { repos, logger = createLogger('resolve'), newId = defaultNewId }: ResolveDeps,
): Promise<ResolutionOutcomeSummary> {
  const analysis = await repos.analyses.getLatestForEmail(email.id);
  const input = buildResolutionInput(email, analysis);
  const resolutionRun = newId();

  const { contacts, companies, threadLinkedEntityIds } = await gatherCandidates(repos, input);

  const contactCandidates = rankCandidates(
    contacts
      .map((candidate) => scoreContact(input, candidate))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .map((candidate) => applyThreadBonus(candidate, threadLinkedEntityIds)),
  );

  const companyCandidates = rankCandidates(
    companies
      .map((candidate) => scoreCompany(input, candidate))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .map((candidate) => applyThreadBonus(candidate, threadLinkedEntityIds)),
  );

  let contact = decideOutcome('contact', contactCandidates);
  let company = decideOutcome('company', companyCandidates);

  const crossConflict = await detectCrossConflict(repos, contact, company);
  if (crossConflict !== null) {
    // Both are downgraded, not just one: the disagreement is between them, so
    // neither verdict can be trusted on its own.
    contact = { ...contact, outcome: 'conflict', verdict: 'MATCH_CONFLICT', selectedEntityId: null, reason: crossConflict };
    company = { ...company, outcome: 'conflict', verdict: 'MATCH_CONFLICT', selectedEntityId: null, reason: crossConflict };
  }

  await repos.entityMatches.recordResolution({
    emailId: email.id,
    analysisId: analysis?.id ?? null,
    resolutionRun,
    resolution: contact,
  });
  await repos.entityMatches.recordResolution({
    emailId: email.id,
    analysisId: analysis?.id ?? null,
    resolutionRun,
    resolution: company,
  });

  for (const resolution of [contact, company]) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'resolve',
      eventType: resolution.outcome === 'conflict' ? 'match_conflict_raised' : 'match_evaluated',
      actor: 'system',
      outcome: resolution.outcome === 'conflict' ? 'blocked' : 'ok',
      summary: resolution.reason,
      payload: {
        entityType: resolution.entityType,
        verdict: resolution.verdict,
        outcome: resolution.outcome,
        candidates: resolution.candidates.map((candidate) => ({
          entityId: candidate.entityId,
          label: candidate.label,
          score: candidate.score,
          method: candidate.method,
        })),
        resolutionRun,
      },
      ...(resolution.selectedEntityId === null
        ? {}
        : { entityType: resolution.entityType, entityId: resolution.selectedEntityId }),
    });
  }

  const hasConflict = contact.outcome === 'conflict' || company.outcome === 'conflict';
  const nextState = hasConflict ? 'needs_review' : 'deciding';
  const reviewReason: ReviewReason | null = hasConflict ? 'match_conflict' : null;

  const updated = await repos.emails.setState(email.id, nextState, { reviewReason });
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'resolve',
    eventType: 'state_changed',
    actor: 'system',
    outcome: 'ok',
    summary: hasConflict
      ? 'Routed to human review: a CRM match could not be decided automatically.'
      : 'Resolved; ready for a recommendation.',
    payload: { state: nextState, reviewReason },
  });

  logger.info('Resolution complete', {
    emailId: email.id,
    contact: contact.verdict,
    company: company.verdict,
    state: nextState,
  });

  return {
    email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
    contact,
    company,
    resolutionRun,
    state: nextState,
    reviewReason,
  };
}

/**
 * Records a human's choice on a conflicted resolution (FR-15's "require a human
 * decision", spec §11's `/resolve-match`).
 *
 * The person may pick a candidate or declare it a new record. Either way the
 * choice is written as a fresh run with outcome `human_selected` — the original
 * machine verdict is untouched, so "what did it think, and what did the person
 * decide?" stays answerable. That difference is the most useful signal this
 * stage produces.
 *
 * Still no CRM write: choosing an existing record links it, and choosing "new"
 * records the intent for M3 to act on.
 */
export async function resolveMatchByHuman(
  email: EmailRecord,
  choice: { entityType: ResolvableEntityType; entityId: string | null; decidedBy: string },
  { repos, logger = createLogger('resolve'), newId = defaultNewId }: ResolveDeps,
): Promise<ResolutionOutcomeSummary> {
  if (email.state !== 'needs_review' || email.reviewReason !== 'match_conflict') {
    throw new AppError('INVALID_STATE', 'This email is not waiting on a CRM match decision.');
  }

  const previous = await repos.entityMatches.getLatestRun(email.id, choice.entityType);
  const analysisId = previous[0]?.analysisId ?? null;

  if (choice.entityId !== null) {
    const exists =
      choice.entityType === 'contact'
        ? await repos.contacts.getById(choice.entityId)
        : await repos.companies.getById(choice.entityId);
    if (!exists) throw new AppError('VALIDATION_ERROR', `That ${choice.entityType} does not exist.`);
  }

  const chosen = previous.find((row) => row.entityId === choice.entityId);
  const resolutionRun = newId();

  const resolution: EntityResolution = {
    entityType: choice.entityType,
    outcome: choice.entityId === null ? 'propose_create' : 'human_selected',
    verdict: choice.entityId === null ? 'NO_MATCH' : 'MATCH',
    selectedEntityId: choice.entityId,
    candidates:
      choice.entityId === null
        ? []
        : [
            {
              entityType: choice.entityType,
              entityId: choice.entityId,
              label: chosen?.evidence ?? 'Chosen by a person',
              score: chosen?.score ?? 1,
              method: chosen?.method ?? 'name_only',
              evidence: `Chosen by ${choice.decidedBy}.`,
              signals: [],
            },
          ],
    reason:
      choice.entityId === null
        ? `${choice.decidedBy} decided this is a new ${choice.entityType}.`
        : `${choice.decidedBy} selected an existing ${choice.entityType}.`,
  };

  await repos.entityMatches.recordResolution({
    emailId: email.id,
    analysisId,
    resolutionRun,
    resolution,
  });

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'resolve',
    eventType: 'match_resolved_by_human',
    actor: 'human',
    actorId: choice.decidedBy,
    outcome: 'ok',
    summary: resolution.reason,
    payload: { entityType: choice.entityType, entityId: choice.entityId, resolutionRun },
    ...(choice.entityId === null ? {} : { entityType: choice.entityType, entityId: choice.entityId }),
  });

  // The other entity type may still be unresolved, so the email only advances
  // once nothing is outstanding.
  const other: ResolvableEntityType = choice.entityType === 'contact' ? 'company' : 'contact';
  const otherRun = await repos.entityMatches.getLatestRun(email.id, other);
  const otherStillConflicted = otherRun.some((row) => row.outcome === 'conflict');

  const nextState = otherStillConflicted ? 'needs_review' : 'deciding';
  const reviewReason: ReviewReason | null = otherStillConflicted ? 'match_conflict' : null;
  const updated = await repos.emails.setState(email.id, nextState, { reviewReason });

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'resolve',
    eventType: 'state_changed',
    actor: 'human',
    actorId: choice.decidedBy,
    outcome: 'ok',
    summary: otherStillConflicted
      ? 'One match decided; another is still waiting on a person.'
      : 'Match decided by a person; ready for a recommendation.',
    payload: { state: nextState, reviewReason },
  });

  logger.info('Human resolved a match conflict', { emailId: email.id, entityType: choice.entityType });

  const contactRun = await repos.entityMatches.getLatestRun(email.id, 'contact');
  const companyRun = await repos.entityMatches.getLatestRun(email.id, 'company');

  return {
    email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
    contact: choice.entityType === 'contact' ? resolution : runToResolution('contact', contactRun),
    company: choice.entityType === 'company' ? resolution : runToResolution('company', companyRun),
    resolutionRun,
    state: nextState,
    reviewReason,
  };
}

/**
 * Rebuilds a stored run into the shape the API and UI read.
 *
 * `label` comes back as the entity id, because the row does not carry a name —
 * the CRM record is the single source of truth for that, and a stored copy
 * would go stale the moment a company is renamed. `enrichCandidateLabels()`
 * below fills them in from the live records.
 */
export function runToResolution(entityType: ResolvableEntityType, rows: ResolutionRecord[]): EntityResolution {
  const outcome = (rows[0]?.outcome ?? 'propose_create') as EntityResolution['outcome'];
  const selected = rows.find((row) => row.selected);

  return {
    entityType,
    outcome,
    verdict: resolutionVerdict(outcome),
    selectedEntityId: selected?.entityId ?? null,
    candidates: rows
      .filter((row) => row.entityId !== null)
      .map((row) => ({
        entityType,
        entityId: row.entityId as string,
        label: row.entityId as string,
        score: row.score,
        method: row.method,
        evidence: row.evidence,
        signals: [],
      })),
    reason: rows[0]?.reason ?? 'No resolution recorded.',
  };
}

/**
 * Replaces candidate ids with the record's current name.
 *
 * Reads the live CRM rather than a stored copy, so a renamed company shows its
 * new name. A candidate whose record has since been deleted keeps its id and is
 * marked, rather than silently disappearing from the explanation of a decision
 * that was made when it still existed.
 */
export async function enrichCandidateLabels(
  repos: Repositories,
  resolution: EntityResolution,
): Promise<EntityResolution> {
  const candidates = await Promise.all(
    resolution.candidates.map(async (candidate) => {
      if (candidate.entityType === 'contact') {
        const contact = await repos.contacts.getById(candidate.entityId);
        return {
          ...candidate,
          label: contact ? `${contact.fullName} <${contact.email}>` : `${candidate.entityId} (deleted)`,
        };
      }
      const company = await repos.companies.getById(candidate.entityId);
      return { ...candidate, label: company ? company.name : `${candidate.entityId} (deleted)` };
    }),
  );

  return { ...resolution, candidates };
}

/** Guards which states may enter resolution. */
export function assertResolvable(email: EmailRecord): void {
  const allowed = ['resolving', 'deciding'];
  if (!allowed.includes(email.state)) {
    throw new AppError(
      'INVALID_STATE',
      `This email cannot be matched to CRM records while it is ${email.state.replace(/_/g, ' ')}.`,
    );
  }
}
