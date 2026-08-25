import { UNDERSTAND_TOOL } from './schema.ts';
import {
  UNDERSTAND_PROMPT_VERSION,
  UNDERSTAND_SYSTEM_PROMPT,
  buildRepairMessages,
  buildUnderstandMessages,
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
  SecurityRecord,
  Understanding,
  ValidationRecord,
} from '../../domain/understanding.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { stableHash } from '../../lib/ids.ts';
import { AppError } from '../../lib/errors.ts';

// STAGE 1 — UNDERSTAND (spec §7).
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
//     returns can cause anything to happen — that is M3's job, behind the
//     approval gate M0 already built.
//   * No trust. Nothing the model says is written to the database before
//     deterministic code has checked it against the email it came from.
//
// The email ends in one of three states, and never in a state that implies
// something is about to happen automatically:
//
//   resolving          — understood; ready for entity resolution (M2).
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

const MAX_ATTEMPTS = 2; // one attempt, then one repair retry (spec §7)

export async function understandEmail(
  email: EmailRecord,
  { repos, provider, logger = createLogger('understand'), thresholds }: UnderstandDeps,
): Promise<UnderstandOutcome> {
  const corpus = provenanceCorpus(email);
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
      logger.error('Provider call failed', { provider: provider.name, attempt, internal: message });

      await repos.emails.setState(email.id, 'understand_failed');
      await repos.audit.append({
        correlationId: email.correlationId,
        emailId: email.id,
        stage: 'understand',
        eventType: 'classification_recorded',
        actor: 'system',
        outcome: 'failed',
        summary: 'The analysis provider could not be reached, so this email was not read.',
        payload: { provider: provider.name, attempt, error: message },
      });

      const security = buildSecurity(email, false);
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
    const security = buildSecurity(email, false);
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

  // --- deterministic security pass -----------------------------------------

  const security = buildSecurity(email, understanding.flags.possibleInjection);

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

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'understand',
    eventType: 'classification_recorded',
    actor: 'ai',
    actorId: modelName,
    outcome: 'ok',
    summary: `Read as ${effective.category.replace(/_/g, ' ')} (${effective.confidenceBand} confidence, ${effective.confidence.toFixed(2)}).`,
    payload: {
      category: effective.category,
      priority: effective.priority,
      confidence: effective.confidence,
      confidenceBand: effective.confidenceBand,
      promptVersion: UNDERSTAND_PROMPT_VERSION,
      // The input is recorded as a digest, not as text: it proves *that* the
      // same email produced this reading without copying the message into a
      // second table that is never deleted (§17).
      inputDigest: `sha256:${stableHash({ subject: email.subject, body: email.bodyText })}`,
      attempts: attempt,
    },
    latencyMs,
    entityType: 'analysis',
    entityId: analysis.id,
  });

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

  // Understood. `resolving` is the next stage in the §8 state machine (entity
  // resolution, M2) — the email waits there rather than in a state that implies
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
 * Which of the §18 conditions, if any, sends this email to a person.
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

function buildSecurity(email: EmailRecord, modelFlagged: boolean): SecurityRecord {
  // Sanitisation already happened at ingestion; what survives here is the
  // record of it, reconstructed from the stored email. The detector runs on the
  // stored (sanitised) text, which is the same text the model was shown.
  const sanitisation = {
    removedHtml: false,
    removedScripts: 0,
    removedRemoteImages: 0,
    removedHiddenCharacters: 0,
    truncated: email.bodyTruncated,
    originalLength: email.bodyText.length,
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
