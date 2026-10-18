import { UNDERSTAND_TOOL } from './schema.ts';
import {
  UNDERSTAND_PROMPT_VERSION,
  UNDERSTAND_SYSTEM_PROMPT,
  buildRepairMessages,
  buildUnderstandMessages,
  identityEvidence,
  provenanceCorpus,
} from './prompt.ts';
import { validateUnderstanding } from './validate.ts';
import { detectInjection } from './injection.ts';
import { LlmUnavailableError, type LlmProvider, type LlmRequest } from '../../adapters/llm/types.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import type { EmailRecord, ReviewReason } from '../../domain/email.ts';
import type {
  AnalysisRecord,
  ModelUnderstanding,
  SanitisationRecord,
  SecurityRecord,
  Understanding,
  ValidationRecord,
} from '../../domain/understanding.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { stableHash } from '../../lib/ids.ts';
import { AppError } from '../../lib/errors.ts';

// STAGE 1 — UNDERSTAND.
//
// The order of operations is the design:
//
//   sanitised email → prompt (fenced, untrusted) → one model call
//                   → shape validation → provenance validation → coherence
//                   → confidence banding → injection detection → persist
//                   → state transition
//
// Two things are deliberately *not* here:
//
//   * No decision. This stage produces a reading, never a plan. Nothing it
//     returns can cause anything to happen — that is DECIDE's job, behind the
//     approval gate the foundation already built.
//   * No trust. Nothing the model says is written to the database before
//     deterministic code has checked it against the email it came from.
//
// The email ends in one of three states, and never in a state that implies
// something is about to happen automatically:
//
//   resolving          — understood; ready for entity resolution.
//   needs_review       — a person must look, with a machine-readable reason.
//   understand_failed  — the provider failed; retryable, nothing persisted.

export type UnderstandOutcome = {
  email: EmailRecord;
  analysis: AnalysisRecord | null;
  understanding: Understanding | null;
  security: SecurityRecord;
  validation: ValidationRecord;
  state: EmailRecord['state'];
  reviewReason: ReviewReason | null;
};

export type UnderstandDeps = {
  repos: Repositories;
  provider: LlmProvider;
  logger?: Logger;
  /** Overrides the stored confidence thresholds; used by the eval runner. */
  thresholds?: { high: number; medium: number };
};

const MAX_ATTEMPTS = 2; // one attempt, then one repair retry

export async function understandEmail(
  email: EmailRecord,
  { repos, provider, logger = createLogger('understand'), thresholds }: UnderstandDeps,
): Promise<UnderstandOutcome> {
  const corpus = provenanceCorpus(email);
  const evidence = identityEvidence(email);
  const effectiveThresholds = thresholds ?? (await repos.settings.get('confidence_thresholds'));

  await repos.emails.setState(email.id, 'understanding');

  // --- the model call, with one repair retry on unusable output -------------

  let attempt = 0;
  let lastProblems: string[] = [];
  let modelOutput: ModelUnderstanding | null = null;
  let understanding: Understanding | null = null;
  let validation: ValidationRecord | null = null;
  // The provider's *reported* model id, which is more specific than the
  // adapter name (e.g. "claude-haiku-4-5-20251001" rather than "anthropic").
  let modelName: string = provider.name;
  let latencyMs = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;

    const request: LlmRequest = {
      purpose: 'understand',
      promptVersion: UNDERSTAND_PROMPT_VERSION,
      systemPrompt: UNDERSTAND_SYSTEM_PROMPT,
      messages: attempt === 1 ? buildUnderstandMessages(email) : buildRepairMessages(email, lastProblems),
      tool: UNDERSTAND_TOOL,
      maxTokens: 2048,
      metadata: { fixtureId: email.providerMessageId },
    };

    let response;
    try {
      response = await provider.complete(request);
    } catch (err) {
      // A provider failure is a provider failure — never a quiet fallback to
      // another provider and never a fabricated result. The email stays in the
      // queue, retryable, and nothing is persisted.
      const message = err instanceof Error ? err.message : String(err);
      // `kind` says whether it was a rate limit, a timeout, an outage or a refusal: the first needs
      // waiting, the last needs a person, and "could not be reached" alone cannot tell them apart.
      const kind = err instanceof LlmUnavailableError ? err.kind : 'unknown';
      logger.error('Provider call failed', { provider: provider.name, attempt, kind, internal: message });

      await repos.emails.setState(email.id, 'understand_failed');
      await repos.audit.append({
        correlationId: email.correlationId,
        emailId: email.id,
        stage: 'understand',
        eventType: 'classification_recorded',
        actor: 'system',
        outcome: 'failed',
        summary: 'The analysis provider could not be reached, so this email was not read.',
        payload: { provider: provider.name, attempt, kind, error: message },
      });

      const security = await buildSecurity(repos, email, false);
      return {
        email: (await repos.emails.getById(email.id)) as EmailRecord,
        analysis: null,
        understanding: null,
        security,
        validation: { problems: [message], droppedFields: [], coherenceAdjustments: [], normalisations: [], attempts: attempt },
        state: 'understand_failed',
        reviewReason: null,
      };
    }

    modelName = response.model;
    latencyMs += response.latencyMs;

    const outcome = validateUnderstanding(response.toolInput, {
      corpus,
      evidence,
      attempt,
      thresholds: effectiveThresholds,
    });

    if (outcome.ok) {
      understanding = outcome.understanding;
      validation = outcome.record;
      modelOutput = response.toolInput as unknown as ModelUnderstanding;
      break;
    }

    lastProblems = outcome.problems;
    validation = outcome.record;
    logger.warn('Model output failed validation', { attempt, problems: outcome.problems });
  }

  // --- unusable after the retry: never partially parsed ---------------------

  if (!understanding || !validation) {
    const security = await buildSecurity(repos, email, false);
    const record: ValidationRecord = validation ?? {
      problems: lastProblems,
      droppedFields: [],
      coherenceAdjustments: [],
      normalisations: [],
      attempts: attempt,
    };

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'classification_recorded',
      actor: 'system',
      outcome: 'blocked',
      summary: 'The analysis could not be read in a usable form, so this email needs a person.',
      payload: { problems: record.problems, attempts: attempt, promptVersion: UNDERSTAND_PROMPT_VERSION },
    });

    const updated = await repos.emails.setState(email.id, 'needs_review', { reviewReason: 'no_valid_plan' });
    return {
      email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
      analysis: null,
      understanding: null,
      security,
      validation: record,
      state: 'needs_review',
      reviewReason: 'no_valid_plan',
    };
  }

  // --- follow-up without context ---------------------------------------------
  //
  // A model that calls an email a follow-up is saying "this continues something already under way". If nothing
  // we hold agrees (no prior thread, no contact with this address, no company on this domain), the claim has no
  // support, and acting on it (advancing a deal that is not there, or filing it as routine) would be acting on a
  // guess. So the category is changed to ambiguous and the email goes to a person. Code decides this, not the
  // prompt: a model can be talked into or out of calling something a follow-up, but whether we know the sender is
  // a fact in our own records.
  const modelReading = understanding;
  const reading = await withFollowUpContextCheck(repos, email, understanding, validation);
  understanding = reading;

  // The model's summary and intent are its own words and are shown as written, but a value the validator discarded must not
  // reach the screen unmarked by that route. Record which discarded values the text still mentions.
  const mentions = discardedValuesMentioned(understanding, validation);
  if (mentions.length > 0) validation.summaryMentions = mentions;

  // --- deterministic security pass -----------------------------------------

  const security = await buildSecurity(repos, email, understanding.flags.possibleInjection);

  // The detector's verdict is authoritative over the model's: an email that
  // successfully manipulated the model would also have persuaded it not to
  // raise the flag, so the flag can only ever be turned ON by this step.
  const effectiveFlags = {
    ...understanding.flags,
    possibleInjection: understanding.flags.possibleInjection || security.injection.suspected,
  };
  const effective: Understanding = { ...understanding, flags: effectiveFlags };

  // --- persist before deciding the state ------------------------------------

  const analysis = await repos.analyses.create({
    emailId: email.id,
    understanding: effective,
    modelOutput: modelOutput ?? {},
    validation,
    security,
    model: modelName,
    promptVersion: UNDERSTAND_PROMPT_VERSION,
    latencyMs,
    attempt,
  });

  // The model's reading is logged under the model's name, exactly as it gave it. If the code then changed the category, that is
  // a second entry under the system's name: a decision made by code is never recorded as the AI's.
  const changedByCode = modelReading.category !== effective.category;
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'understand',
    eventType: 'classification_recorded',
    actor: 'ai',
    actorId: modelName,
    outcome: 'ok',
    summary: `Read as ${modelReading.category.replace(/_/g, ' ')} (${modelReading.confidenceBand} confidence, ${modelReading.confidence.toFixed(2)}).`,
    payload: {
      category: modelReading.category,
      priority: modelReading.priority,
      confidence: modelReading.confidence,
      confidenceBand: modelReading.confidenceBand,
      promptVersion: UNDERSTAND_PROMPT_VERSION,
      // The input is recorded as a digest, not as text: it proves *that* the
      // same email produced this reading without copying the message into a
      // second table that is never deleted.
      inputDigest: `sha256:${stableHash({ subject: email.subject, body: email.bodyText })}`,
      attempts: attempt,
      // Named rules the code applied to the model's reading (see validation.coherenceAdjustments).
      rules: validation.coherenceAdjustments.flatMap((adjustment) => (adjustment.rule ? [adjustment.rule] : [])),
    },
    latencyMs,
    entityType: 'analysis',
    entityId: analysis.id,
  });

  if (changedByCode) {
    const change = validation.coherenceAdjustments.find((adjustment) => adjustment.rule !== undefined);
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'category_changed_by_code',
      actor: 'system',
      outcome: 'ok',
      summary: `Changed the category from ${modelReading.category.replace(/_/g, ' ')} to ${effective.category.replace(/_/g, ' ')}: ${change?.why ?? 'a rule in the code applied'}.`,
      payload: { from: modelReading.category, to: effective.category, rule: change?.rule ?? null },
      entityType: 'analysis',
      entityId: analysis.id,
    });
  }

  if (validation.summaryMentions && validation.summaryMentions.length > 0) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'summary_mentions_discarded_value',
      actor: 'system',
      outcome: 'ok',
      summary: `The model's own summary or intent still mentions a value that was discarded (${validation.summaryMentions.map((m) => `${m.field}: "${m.claimedValue}"`).join('; ')}). Its text is shown as written, with a marker.`,
      payload: { mentions: validation.summaryMentions },
      entityType: 'analysis',
      entityId: analysis.id,
    });
  }

  const extractedCount = Object.values(effective.extracted).filter((field) => field.value !== null).length;
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'understand',
    eventType: 'extraction_recorded',
    actor: 'ai',
    actorId: modelName,
    outcome: 'ok',
    summary: `Extracted ${extractedCount} field(s) with supporting text from the email.`,
    payload: { extractedCount, promptVersion: UNDERSTAND_PROMPT_VERSION },
    entityType: 'analysis',
    entityId: analysis.id,
  });

  // Each dropped field is its own audit event. This is the anti-hallucination
  // record, and it is the answer to "why did it ignore the budget in my email?"
  for (const dropped of validation.droppedFields) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'field_dropped_no_provenance',
      actor: 'system',
      outcome: 'blocked',
      summary: `Discarded the ${dropped.field} the agent proposed: ${dropped.reason}.`,
      payload: { field: dropped.field, reason: dropped.reason },
      entityType: 'analysis',
      entityId: analysis.id,
    });
  }

  if (security.injection.suspected) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'injection_suspected',
      actor: 'system',
      outcome: 'blocked',
      summary: 'This email contains text that tries to instruct the agent. Routed to a person.',
      payload: {
        rules: security.injection.matches.map((match) => match.rule),
        modelFlagged: security.injection.modelFlagged,
      },
      entityType: 'analysis',
      entityId: analysis.id,
    });
  }

  // --- state transition ------------------------------------------------------

  const reviewReason = decideReviewReason(effective, security);

  if (reviewReason !== null) {
    const updated = await repos.emails.setState(email.id, 'needs_review', { reviewReason });
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'understand',
      eventType: 'state_changed',
      actor: 'system',
      outcome: 'ok',
      summary: `Routed to human review: ${reviewReason.replace(/_/g, ' ')}.`,
      payload: { state: 'needs_review', reviewReason },
    });
    return {
      email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
      analysis,
      understanding: effective,
      security,
      validation,
      state: 'needs_review',
      reviewReason,
    };
  }

  // Understood. `resolving` is the next stage in the specification's state machine (entity
  // resolution, RESOLVE) — the email waits there rather than in a state that implies
  // anything is about to be done to a CRM.
  const updated = await repos.emails.setState(email.id, 'resolving');
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'understand',
    eventType: 'state_changed',
    actor: 'system',
    outcome: 'ok',
    summary: 'Understood; waiting for entity resolution.',
    payload: { state: 'resolving' },
  });

  return {
    email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
    analysis,
    understanding: effective,
    security,
    validation,
    state: 'resolving',
    reviewReason: null,
  };
}

/**
 * Which of the specification's conditions, if any, sends this email to a person.
 *
 * Order matters only for which reason gets reported; any one of them is
 * sufficient. Every branch here routes *towards* the human — there is no
 * condition under which uncertainty resolves into proceeding.
 */
function decideReviewReason(understanding: Understanding, security: SecurityRecord): ReviewReason | null {
  if (security.injection.suspected) return 'possible_injection';
  if (understanding.flags.ambiguousIntent || understanding.category === 'ambiguous') return 'ambiguous_intent';
  if (understanding.flags.insufficientInformation) return 'insufficient_information';
  if (understanding.confidenceBand === 'low') return 'low_confidence';
  return null;
}

export const FOLLOW_UP_WITHOUT_CONTEXT = 'follow_up_without_context';

function normalisedForMention(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Discarded values that the model's summary or intent still names. A value shorter than three characters is too short to mean
 * anything by appearing, and the text "null" is not a value.
 */
export function discardedValuesMentioned(understanding: Understanding, validation: ValidationRecord): NonNullable<ValidationRecord['summaryMentions']> {
  const summary = normalisedForMention(understanding.summary);
  const intent = normalisedForMention(understanding.intent);
  const found: NonNullable<ValidationRecord['summaryMentions']> = [];
  for (const dropped of validation.droppedFields) {
    const value = normalisedForMention(dropped.claimedValue);
    if (value.length < 3 || value === 'null') continue;
    const where: Array<'summary' | 'intent'> = [];
    if (summary.includes(value)) where.push('summary');
    if (intent.includes(value)) where.push('intent');
    if (where.length > 0) found.push({ field: dropped.field, claimedValue: dropped.claimedValue, in: where });
  }
  return found;
}

/** What we already know about this sender: a thread, a contact with this address, or a company on this domain. */
export async function senderContext(repos: Repositories, email: EmailRecord): Promise<{ known: boolean; because: string | null }> {
  if (email.threadId !== null) return { known: true, because: 'the email is part of an existing thread' };
  if ((await repos.contacts.findByEmail(email.fromEmail)) !== null) return { known: true, because: 'a CRM contact has this address' };
  const domain = email.fromEmail.split('@')[1] ?? '';
  if (domain !== '' && (await repos.companies.findByDomain(domain)) !== null) return { known: true, because: 'a CRM company has this domain' };
  return { known: false, because: null };
}

async function withFollowUpContextCheck(
  repos: Repositories,
  email: EmailRecord,
  understanding: Understanding,
  validation: ValidationRecord,
): Promise<Understanding> {
  if (understanding.category !== 'follow_up') return understanding;
  const context = await senderContext(repos, email);
  if (context.known) return understanding;

  validation.coherenceAdjustments.push({
    what: 'changed the category from follow_up to ambiguous',
    why:
      'the reading says this continues an earlier conversation, but there is no prior thread, no CRM contact with this address and no CRM company on this domain, so nothing supports it',
    rule: FOLLOW_UP_WITHOUT_CONTEXT,
  });
  return { ...understanding, category: 'ambiguous', flags: { ...understanding.flags, ambiguousIntent: true } };
}

async function buildSecurity(repos: Repositories, email: EmailRecord, modelFlagged: boolean): Promise<SecurityRecord> {
  // Sanitisation already happened at ingestion, and the record of what it removed was written to the audit
  // log then (an event exists only when something was removed). It is read back here so that the detector
  // can treat hidden characters and hidden elements as findings. An email with no such event had nothing
  // removed, so a record of zeros is the true one. The detector runs on the stored (sanitised) text, which is
  // the same text the model was shown.
  const stored = (await repos.audit.listByEmail(email.id)).find((event) => event.eventType === 'content_sanitised');
  const recorded = (stored?.payload ?? {}) as Partial<SanitisationRecord>;
  const sanitisation: SanitisationRecord = {
    removedHtml: recorded.removedHtml ?? false,
    removedScripts: recorded.removedScripts ?? 0,
    removedRemoteImages: recorded.removedRemoteImages ?? 0,
    removedHiddenCharacters: recorded.removedHiddenCharacters ?? 0,
    removedHiddenElements: recorded.removedHiddenElements ?? 0,
    ...(typeof recorded.hiddenText === 'string' ? { hiddenText: recorded.hiddenText } : {}),
    truncated: email.bodyTruncated,
    originalLength: recorded.originalLength ?? email.bodyText.length,
    finalLength: email.bodyText.length,
  };

  const injection = detectInjection(`${email.subject}\n${email.bodyText}`, {
    sanitisation,
    modelFlagged,
  });

  return { sanitisation, injection };
}

/** Thrown when an email is asked to be understood from a state that forbids it. */
export function assertUnderstandable(email: EmailRecord): void {
  const allowed = ['received', 'understand_failed', 'needs_review', 'resolving'];
  if (!allowed.includes(email.state)) {
    throw new AppError('INVALID_STATE', `This email cannot be analysed while it is ${email.state.replace(/_/g, ' ')}.`);
  }
}

export { LlmUnavailableError };
