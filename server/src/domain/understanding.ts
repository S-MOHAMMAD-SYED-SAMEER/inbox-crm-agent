import type { EmailCategory, Priority, ConfidenceBand } from './email.ts';

// The UNDERSTAND stage's vocabulary and output shape (spec §7, FR-5..FR-11).
//
// Everything the model is allowed to tell us is described here, as a closed
// set. That is what makes the difference between "the model returned JSON" and
// "the model returned something this system can act on": an unknown field, an
// unknown category, or a value with no evidence behind it is rejected by
// deterministic code before it reaches a database row.

/**
 * The fields the model may extract (FR-7).
 *
 * Closed on purpose. A model that invents `estimatedDealSize` does not get a
 * new field — it gets a validation error, because a field nobody designed a
 * meaning for cannot be shown to an operator or written to a CRM.
 */
export const EXTRACTED_FIELDS = [
  'contactName',
  'contactEmail',
  'contactPhone',
  'jobTitle',
  'companyName',
  'companyDomain',
  'serviceInterest',
  'requirementSummary',
  'budget',
  'timeline',
  'urgencyCues',
] as const;
export type ExtractedField = (typeof EXTRACTED_FIELDS)[number];

/**
 * Fields where the *value itself* must appear in the email, not merely its
 * evidence span.
 *
 * These are structural identifiers: an address, a domain, a phone number. For
 * them, "close enough" is meaningless — a single wrong character makes the
 * value useless, and a plausible-looking invented one is worse than nothing,
 * because it will be believed. Everything else (a budget written "$2–3k" and
 * normalised to "2000-3000 USD", a paraphrased requirement) is allowed to
 * differ from its span, since a paraphrase there is useful rather than
 * dangerous — it still has to *have* a span.
 */
export const VERBATIM_VALUE_FIELDS: readonly ExtractedField[] = [
  'contactEmail',
  'contactPhone',
  'companyDomain',
];

/**
 * Fields whose evidence must contain a number.
 *
 * A budget with no number anywhere in the text it supposedly came from is not
 * an extraction, it is a guess wearing an extraction's clothes. Money is always
 * written with digits, so this check costs nothing and blocks the single
 * invented value that does the most damage downstream — a fabricated budget
 * becomes a deal amount.
 */
export const NUMERIC_EVIDENCE_FIELDS: readonly ExtractedField[] = ['budget'];

/**
 * Fields whose evidence must contain a number OR a word about time.
 *
 * Timelines are the case where a digits-only rule is wrong: "before the
 * November peak", "end of quarter" and "as soon as possible" are all real,
 * actionable timelines with no digit in them. Demanding one discarded a correct
 * extraction from the demo dataset, which is exactly the false-positive that
 * teaches people to distrust a validator. So the requirement is evidence that
 * is *about time* — by a number or by a word.
 */
export const TEMPORAL_EVIDENCE_FIELDS: readonly ExtractedField[] = ['timeline'];

export const TEMPORAL_EVIDENCE_PATTERN =
  /\d|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|tonight|days?|weeks?|fortnight|months?|quarters?|years?|deadline|asap|immediately|urgent|soon|shortly|peak|season|launch)\b/i;

export function isExtractedField(value: unknown): value is ExtractedField {
  return typeof value === 'string' && (EXTRACTED_FIELDS as readonly string[]).includes(value);
}

/**
 * One extracted field.
 *
 * `value: null` means **not provided** — the email did not say. It never means
 * "the model was unsure" and it is never a placeholder for a guess. That
 * distinction is the entire point of the field: an operator reading "Budget —
 * Not provided" learns something true, whereas an operator reading an invented
 * number learns something false and acts on it.
 */
export type ExtractedValue = {
  value: string | null;
  confidence: number;
  /** The exact email text this came from. Required whenever `value` is non-null. */
  sourceSpan: string | null;
};

export type UnderstandingFlags = {
  insufficientInformation: boolean;
  ambiguousIntent: boolean;
  /** The model's own read. A deterministic detector runs independently (§19). */
  possibleInjection: boolean;
};

/** Exactly what the model is asked to produce — before any validation. */
export type ModelUnderstanding = {
  category: EmailCategory;
  intent: string;
  priority: Priority;
  priorityReason: string;
  confidence: number;
  flags: UnderstandingFlags;
  extracted: Record<ExtractedField, ExtractedValue>;
  questionAsked: string | null;
  summary: string;
};

/** What deterministic code did to the model's answer. */
export type ValidationRecord = {
  /** Shape/semantic problems that made the output unusable at all. */
  problems: string[];
  /** Fields reset to not_provided, with the reason. The anti-hallucination record. */
  droppedFields: Array<{ field: ExtractedField; reason: string; claimedValue: string }>;
  /** Incoherences deterministic code corrected, e.g. a missing ambiguity flag. */
  coherenceAdjustments: Array<{ what: string; why: string }>;
  /** Values normalised without changing meaning, e.g. an over-long summary. */
  normalisations: Array<{ what: string; why: string }>;
  attempts: number;
};

export type SanitisationRecord = {
  removedHtml: boolean;
  removedScripts: number;
  removedRemoteImages: number;
  removedHiddenCharacters: number;
  truncated: boolean;
  originalLength: number;
  finalLength: number;
};

export type InjectionMatch = {
  rule: string;
  severity: 'high' | 'medium';
  /** The offending text, trimmed. Shown to the operator so they can judge it. */
  evidence: string;
  why: string;
};

export type InjectionRecord = {
  suspected: boolean;
  matches: InjectionMatch[];
  /** True when the model also flagged it. Agreement is informative, not required. */
  modelFlagged: boolean;
};

export type SecurityRecord = {
  sanitisation: SanitisationRecord;
  injection: InjectionRecord;
};

/**
 * The validated understanding the rest of the system reads.
 *
 * `flags` here are the EFFECTIVE flags: the model's, plus anything
 * deterministic code concluded on its own. `modelOutput` keeps the original
 * answer so the difference is always inspectable.
 */
export type Understanding = {
  category: EmailCategory;
  intent: string;
  priority: Priority;
  priorityReason: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  flags: UnderstandingFlags;
  extracted: Record<ExtractedField, ExtractedValue>;
  questionAsked: string | null;
  summary: string;
};

export type AnalysisRecord = {
  id: string;
  emailId: string;
  understanding: Understanding;
  modelOutput: ModelUnderstanding | Record<string, never>;
  validation: ValidationRecord;
  security: SecurityRecord;
  model: string;
  promptVersion: string;
  latencyMs: number;
  attempt: number;
  createdAt: string;
};

/** An extracted map with every field absent — the honest starting point. */
export function emptyExtraction(): Record<ExtractedField, ExtractedValue> {
  const out = {} as Record<ExtractedField, ExtractedValue>;
  for (const field of EXTRACTED_FIELDS) {
    out[field] = { value: null, confidence: 0, sourceSpan: null };
  }
  return out;
}
