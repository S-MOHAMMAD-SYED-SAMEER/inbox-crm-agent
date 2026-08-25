// Entity-resolution vocabulary (spec §7, FR-12..FR-15).
//
// THE THREE-WAY VERDICT AND THE FOUR STORED OUTCOMES
//
// The resolution stage answers one question — "which existing CRM record, if
// any, is this?" — with one of three verdicts: MATCH, NO_MATCH, MATCH_CONFLICT.
//
// What gets *stored* is the spec's own four-value set, fixed by the CHECK
// constraint the M0 migration already created:
//
//   auto_linked     → MATCH           a candidate cleared the high threshold
//   propose_create  → NO_MATCH        nothing qualified; this is a new record
//   conflict        → MATCH_CONFLICT  a human must choose
//   human_selected  → MATCH           a person resolved a conflict by hand
//
// Both vocabularies are kept rather than one replacing the other, because they
// answer different questions. `outcome` records *how* the link came to exist —
// which matters six months later when someone asks whether a record was matched
// automatically or by a person. `verdict` is the three-way summary an operator
// and the UI reason about. `resolutionVerdict()` below is the single mapping
// between them, so the two can never drift.

export const RESOLUTION_OUTCOMES = ['auto_linked', 'propose_create', 'conflict', 'human_selected'] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export const RESOLUTION_VERDICTS = ['MATCH', 'NO_MATCH', 'MATCH_CONFLICT'] as const;
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

export function resolutionVerdict(outcome: ResolutionOutcome): ResolutionVerdict {
  switch (outcome) {
    case 'auto_linked':
    case 'human_selected':
      return 'MATCH';
    case 'conflict':
      return 'MATCH_CONFLICT';
    case 'propose_create':
      return 'NO_MATCH';
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unknown resolution outcome: ${String(exhaustive)}`);
    }
  }
}

/** The entity kinds resolution handles. `deal` is in the schema for M3. */
export const RESOLVABLE_ENTITY_TYPES = ['contact', 'company'] as const;
export type ResolvableEntityType = (typeof RESOLVABLE_ENTITY_TYPES)[number];

/**
 * How a candidate earned its score. Stored on every candidate row so the
 * evidence is machine-readable as well as human-readable.
 *
 * `distinctive_token` is the one method not named in spec §7 — see
 * agent/resolve/score.ts for why it exists and what it is worth.
 */
export const MATCH_METHODS = [
  'exact_email',
  'exact_domain',
  'domain_and_exact_name',
  'domain_and_fuzzy_name',
  'exact_name_norm',
  'fuzzy_name',
  'distinctive_token',
  'name_only',
  'thread',
] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

/** One scored candidate, with the evidence for its score. */
export type Candidate = {
  entityType: ResolvableEntityType;
  entityId: string;
  /** Human-readable label — the company or contact name, for the UI. */
  label: string;
  score: number;
  method: MatchMethod;
  /** One sentence an operator can read: why this candidate scored what it did. */
  evidence: string;
  /** Every signal that contributed, including the thread bonus. */
  signals: Array<{ method: MatchMethod; score: number; evidence: string }>;
};

/** The verdict for one entity type on one email. */
export type EntityResolution = {
  entityType: ResolvableEntityType;
  outcome: ResolutionOutcome;
  verdict: ResolutionVerdict;
  /** The linked record, when there is one. Null for NO_MATCH and MATCH_CONFLICT. */
  selectedEntityId: string | null;
  /** Every candidate considered, best first. */
  candidates: Candidate[];
  /** Why this verdict, in one sentence. Required — a verdict nobody can read is not explainable. */
  reason: string;
};

export type ResolutionRecord = {
  id: string;
  emailId: string;
  analysisId: string | null;
  resolutionRun: string;
  entityType: ResolvableEntityType;
  entityId: string | null;
  score: number;
  method: MatchMethod;
  evidence: string;
  outcome: ResolutionOutcome;
  rank: number;
  selected: boolean;
  /** The run's verdict in one sentence — see migration 005. */
  reason: string;
  createdAt: string;
};

/**
 * Thresholds, exactly as spec §7 states them.
 *
 * Note what the middle band means in practice: a score between 0.50 and 0.80 is
 * not "a weak match", it is "a human decides". A candidate is never promoted
 * just for being the only one — being alone is not evidence.
 */
export const RESOLUTION_THRESHOLDS = {
  /** At or above this, link automatically. */
  autoLink: 0.8,
  /** Below this, propose creating a new record. */
  proposeCreate: 0.5,
  /** Two candidates within this of each other are too close to separate. */
  conflictWindow: 0.1,
} as const;

export function isResolutionOutcome(value: unknown): value is ResolutionOutcome {
  return typeof value === 'string' && (RESOLUTION_OUTCOMES as readonly string[]).includes(value);
}
