import { EMAIL_CATEGORIES, PRIORITIES, confidenceBand } from '../../domain/email.ts';
import {
  EXTRACTED_FIELDS,
  NUMERIC_EVIDENCE_FIELDS,
  TEMPORAL_EVIDENCE_FIELDS,
  TEMPORAL_EVIDENCE_PATTERN,
  VERBATIM_VALUE_FIELDS,
  emptyExtraction,
  type ExtractedField,
  type ExtractedValue,
  type ModelUnderstanding,
  type Understanding,
  type ValidationRecord,
} from '../../domain/understanding.ts';
import type { EmailCategory, Priority } from '../../domain/email.ts';

// Deterministic validation of model output (FR-8, FR-10, FR-11).
//
// **A model is not trusted because it returned valid JSON.** Provider-side
// schema enforcement guarantees a shape; it guarantees nothing about meaning. A
// schema-valid response can still claim a confidence of 4.7, a budget that
// appears nowhere in the email, or a category of "sales_inquiry" on a message
// that says nothing at all.
//
// So validation runs in three passes, in this order, because each depends on
// the previous one having succeeded:
//
//   1. SHAPE     — is this even the right kind of object? Failures here are
//                  fatal and trigger the single repair retry: there is nothing
//                  to salvage from an answer we cannot read.
//   2. PROVENANCE— does each claimed value have evidence that actually appears
//                  in the email? Failures here are NOT fatal. The offending
//                  field is dropped to not_provided and the rest is kept,
//                  because "the model invented a budget" should cost the budget
//                  field, not the whole reading.
//   3. COHERENCE — does the answer contradict itself? A model that reports
//                  ambiguity but picks a confident category, or claims a
//                  category while extracting nothing at all, gets corrected
//                  deterministically and the correction is recorded.
//
// Every pass records what it did. `validation.droppedFields` is the
// anti-hallucination audit trail, and it is what makes "why did it ignore the
// budget in my email?" answerable with a diff instead of a shrug.

export type ValidationOutcome =
  | { ok: true; understanding: Understanding; record: ValidationRecord }
  | { ok: false; problems: string[]; record: ValidationRecord };

const MAX_SUMMARY = 240;

function emptyRecord(attempt: number): ValidationRecord {
  return { problems: [], droppedFields: [], coherenceAdjustments: [], normalisations: [], attempts: attempt };
}

// ---------------------------------------------------------------- pass 1

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateShape(raw: unknown, problems: string[]): ModelUnderstanding | null {
  if (!isPlainObject(raw)) {
    problems.push('the tool input was not an object');
    return null;
  }

  const category = raw.category;
  if (typeof category !== 'string' || !(EMAIL_CATEGORIES as readonly string[]).includes(category)) {
    problems.push(`"category" must be one of: ${EMAIL_CATEGORIES.join(', ')}`);
  }

  const priority = raw.priority;
  if (typeof priority !== 'string' || !(PRIORITIES as readonly string[]).includes(priority)) {
    problems.push(`"priority" must be one of: ${PRIORITIES.join(', ')}`);
  }

  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    problems.push('"confidence" must be a number between 0 and 1');
  }

  for (const field of ['intent', 'priorityReason', 'summary'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`"${field}" must be a non-empty string`);
    }
  }

  if (raw.questionAsked !== null && typeof raw.questionAsked !== 'string') {
    problems.push('"questionAsked" must be a string or null');
  }

  const flags = raw.flags;
  if (!isPlainObject(flags)) {
    problems.push('"flags" must be an object');
  } else {
    for (const flag of ['insufficientInformation', 'ambiguousIntent', 'possibleInjection'] as const) {
      if (typeof flags[flag] !== 'boolean') problems.push(`"flags.${flag}" must be a boolean`);
    }
  }

  const extracted = raw.extracted;
  if (!isPlainObject(extracted)) {
    problems.push('"extracted" must be an object');
  } else {
    // Closed set, checked in both directions: a missing field is as much a
    // problem as an invented one, because a caller reading `extracted.budget`
    // must never get `undefined`.
    for (const key of Object.keys(extracted)) {
      if (!(EXTRACTED_FIELDS as readonly string[]).includes(key)) {
        problems.push(`"extracted" contains unknown field "${key}"`);
      }
    }
    for (const field of EXTRACTED_FIELDS) {
      const value = extracted[field];
      if (!isPlainObject(value)) {
        problems.push(`"extracted.${field}" must be an object`);
        continue;
      }
      if (value.value !== null && typeof value.value !== 'string') {
        problems.push(`"extracted.${field}.value" must be a string or null`);
      }
      if (value.sourceSpan !== null && typeof value.sourceSpan !== 'string') {
        problems.push(`"extracted.${field}.sourceSpan" must be a string or null`);
      }
      const fieldConfidence = value.confidence;
      if (
        typeof fieldConfidence !== 'number' ||
        !Number.isFinite(fieldConfidence) ||
        fieldConfidence < 0 ||
        fieldConfidence > 1
      ) {
        problems.push(`"extracted.${field}.confidence" must be a number between 0 and 1`);
      }
    }
  }

  if (problems.length > 0) return null;

  return {
    category: category as EmailCategory,
    intent: (raw.intent as string).trim(),
    priority: priority as Priority,
    priorityReason: (raw.priorityReason as string).trim(),
    confidence: confidence as number,
    flags: {
      insufficientInformation: (flags as Record<string, boolean>).insufficientInformation as boolean,
      ambiguousIntent: (flags as Record<string, boolean>).ambiguousIntent as boolean,
      possibleInjection: (flags as Record<string, boolean>).possibleInjection as boolean,
    },
    extracted: Object.fromEntries(
      EXTRACTED_FIELDS.map((field) => {
        const value = (extracted as Record<string, Record<string, unknown>>)[field] as Record<string, unknown>;
        return [
          field,
          {
            value: value.value as string | null,
            confidence: value.confidence as number,
            sourceSpan: value.sourceSpan as string | null,
          } satisfies ExtractedValue,
        ];
      }),
    ) as Record<ExtractedField, ExtractedValue>,
    questionAsked: raw.questionAsked as string | null,
    summary: (raw.summary as string).trim(),
  };
}

// ---------------------------------------------------------------- pass 2

/**
 * Whitespace-insensitive, case-insensitive containment.
 *
 * A model reproducing a span from a wrapped email will not preserve the line
 * breaks, and rejecting a correct extraction over a newline would train
 * everyone to distrust the validator. Punctuation and wording still have to
 * match — this normalises whitespace only.
 */
function normaliseForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function corpusContains(corpus: string, candidate: string): boolean {
  return normaliseForMatch(corpus).includes(normaliseForMatch(candidate));
}

/** Phone numbers legitimately differ in spacing and punctuation. */
function digitsOnly(text: string): string {
  return text.replace(/\D/g, '');
}

function validateProvenance(
  understanding: ModelUnderstanding,
  corpus: string,
  record: ValidationRecord,
): Record<ExtractedField, ExtractedValue> {
  const kept = emptyExtraction();

  for (const field of EXTRACTED_FIELDS) {
    const claimed = understanding.extracted[field];

    if (claimed.value === null) {
      // Not provided is the honest answer and needs no evidence. A span
      // attached to a null value is meaningless, so it is not carried over.
      kept[field] = { value: null, confidence: claimed.confidence, sourceSpan: null };
      continue;
    }

    const drop = (reason: string): void => {
      record.droppedFields.push({ field, reason, claimedValue: claimed.value as string });
      kept[field] = { value: null, confidence: 0, sourceSpan: null };
    };

    const span = claimed.sourceSpan;
    if (span === null || span.trim() === '') {
      drop('the model gave a value with no supporting text from the email');
      continue;
    }

    if (!corpusContains(corpus, span)) {
      drop('the quoted supporting text does not appear in the email');
      continue;
    }

    // Structural identifiers must themselves appear — see the note on
    // VERBATIM_VALUE_FIELDS. A near-miss address is not a useful address.
    if (VERBATIM_VALUE_FIELDS.includes(field)) {
      const matched =
        field === 'contactPhone'
          ? digitsOnly(corpus).includes(digitsOnly(claimed.value)) && digitsOnly(claimed.value).length >= 7
          : corpusContains(corpus, claimed.value);
      if (!matched) {
        drop('the value itself does not appear in the email, and this field must be exact');
        continue;
      }
    }

    // A money claim whose evidence contains no number is not evidence.
    if (NUMERIC_EVIDENCE_FIELDS.includes(field) && !/\d/.test(span)) {
      drop('the supporting text contains no number, so it cannot support a budget');
      continue;
    }

    // A timeline may be worded rather than numbered ("before the November
    // peak"), but its evidence still has to be about time.
    if (TEMPORAL_EVIDENCE_FIELDS.includes(field) && !TEMPORAL_EVIDENCE_PATTERN.test(span)) {
      drop('the supporting text says nothing about timing, so it cannot support a timeline');
      continue;
    }

    kept[field] = { value: claimed.value, confidence: claimed.confidence, sourceSpan: span };
  }

  return kept;
}

// ---------------------------------------------------------------- pass 3

function applyCoherence(
  understanding: ModelUnderstanding,
  extracted: Record<ExtractedField, ExtractedValue>,
  record: ValidationRecord,
): { category: EmailCategory; flags: ModelUnderstanding['flags']; summary: string } {
  let category = understanding.category;
  const flags = { ...understanding.flags };
  let summary = understanding.summary;

  // An "ambiguous" category and a claim of unambiguous intent cannot both be
  // true. The category is the stronger statement, so the flag follows it.
  if (category === 'ambiguous' && !flags.ambiguousIntent) {
    flags.ambiguousIntent = true;
    record.coherenceAdjustments.push({
      what: 'set flags.ambiguousIntent',
      why: 'the category is "ambiguous", so the intent is ambiguous by definition',
    });
  }

  // The dangerous case: a confident-sounding business category with nothing
  // whatsoever extracted from the email. Whatever the model's confidence says,
  // there is not enough here to act on, and saying so routes it to a person.
  const anyExtraction = EXTRACTED_FIELDS.some((field) => extracted[field].value !== null);
  const businessCategory = !['spam', 'vendor_pitch', 'ambiguous'].includes(category);
  if (businessCategory && !anyExtraction && !flags.insufficientInformation) {
    flags.insufficientInformation = true;
    record.coherenceAdjustments.push({
      what: 'set flags.insufficientInformation',
      why: 'no field could be supported by the email, so there is nothing here to act on',
    });
  }

  // Dropping every field the model claimed is itself a signal about the
  // reading, not just about the fields.
  if (record.droppedFields.length > 0 && !anyExtraction && !flags.insufficientInformation) {
    flags.insufficientInformation = true;
    record.coherenceAdjustments.push({
      what: 'set flags.insufficientInformation',
      why: 'every extracted value was discarded for lacking support in the email',
    });
  }

  if (summary.length > MAX_SUMMARY) {
    summary = `${summary.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
    record.normalisations.push({
      what: 'shortened the summary',
      why: `a summary is a list-view line and is capped at ${MAX_SUMMARY} characters`,
    });
  }

  return { category, flags, summary };
}

// ---------------------------------------------------------------- entry

export function validateUnderstanding(
  raw: unknown,
  options: { corpus: string; attempt?: number; thresholds?: { high: number; medium: number } },
): ValidationOutcome {
  const record = emptyRecord(options.attempt ?? 1);
  const problems: string[] = [];

  const shaped = validateShape(raw, problems);
  if (!shaped) {
    record.problems = problems;
    return { ok: false, problems, record };
  }

  const extracted = validateProvenance(shaped, options.corpus, record);
  const { category, flags, summary } = applyCoherence(shaped, extracted, record);

  const understanding: Understanding = {
    category,
    intent: shaped.intent,
    priority: shaped.priority,
    priorityReason: shaped.priorityReason,
    confidence: shaped.confidence,
    confidenceBand: confidenceBand(shaped.confidence, options.thresholds),
    flags,
    extracted,
    questionAsked: shaped.questionAsked === '' ? null : shaped.questionAsked,
    summary,
  };

  return { ok: true, understanding, record };
}

export { normaliseForMatch };
