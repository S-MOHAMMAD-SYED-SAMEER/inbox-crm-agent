import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toJson, fromJson } from '../rows.ts';
import type { EmailCategory, Priority, ConfidenceBand } from '../../domain/email.ts';
import type {
  AnalysisRecord,
  ExtractedField,
  ExtractedValue,
  SecurityRecord,
  Understanding,
  UnderstandingFlags,
  ValidationRecord,
  ModelUnderstanding,
} from '../../domain/understanding.ts';

// Analysis persistence (M1).
//
// Append-only in practice: an analysis is never updated. Re-running UNDERSTAND
// on an email inserts a *new* row, and `getLatestForEmail` returns the newest.
// The earlier readings stay, because "what did it think before, and what
// changed?" is a question worth being able to answer — and because rewriting
// history is exactly what the audit trail exists to prevent.
//
// The four kinds of knowledge stay in separate columns (migration 004): the
// model's raw answer, the effective understanding, what deterministic
// validation did, and what the security checks found.

function mapAnalysis(row: Record<string, unknown>): AnalysisRecord {
  const understanding: Understanding = {
    category: toText(row.category) as EmailCategory,
    intent: toText(row.intent),
    priority: toText(row.priority) as Priority,
    priorityReason: toText(row.priority_reason),
    confidence: toNumber(row.confidence),
    confidenceBand: toText(row.confidence_band) as ConfidenceBand,
    flags: toJson<UnderstandingFlags>(row.flags, {
      insufficientInformation: false,
      ambiguousIntent: false,
      possibleInjection: false,
    }),
    extracted: toJson<Record<ExtractedField, ExtractedValue>>(row.extracted, {} as Record<ExtractedField, ExtractedValue>),
    questionAsked: toTextOrNull(row.question_asked),
    summary: toText(row.summary),
  };

  return {
    id: toText(row.id),
    emailId: toText(row.email_id),
    understanding,
    modelOutput: toJson<ModelUnderstanding | Record<string, never>>(row.model_output, {}),
    validation: toJson<ValidationRecord>(row.validation, {
      problems: [],
      droppedFields: [],
      coherenceAdjustments: [],
      normalisations: [],
      attempts: 1,
    }),
    security: toJson<SecurityRecord>(row.security, {
      sanitisation: {
        removedHtml: false,
        removedScripts: 0,
        removedRemoteImages: 0,
        removedHiddenCharacters: 0,
        truncated: false,
        originalLength: 0,
        finalLength: 0,
      },
      injection: { suspected: false, matches: [], modelFlagged: false },
    }),
    model: toText(row.model),
    promptVersion: toText(row.prompt_version),
    latencyMs: toNumber(row.latency_ms),
    attempt: toNumber(row.attempt),
    createdAt: toText(row.created_at),
  };
}

export type CreateAnalysisInput = {
  emailId: string;
  understanding: Understanding;
  modelOutput: ModelUnderstanding | Record<string, never>;
  validation: ValidationRecord;
  security: SecurityRecord;
  model: string;
  promptVersion: string;
  latencyMs: number;
  attempt: number;
};

export function createAnalysisRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateAnalysisInput): Promise<AnalysisRecord> {
      const values = {
        id: newId(),
        email_id: input.emailId,
        category: input.understanding.category,
        intent: input.understanding.intent,
        priority: input.understanding.priority,
        priority_reason: input.understanding.priorityReason,
        confidence: input.understanding.confidence,
        confidence_band: input.understanding.confidenceBand,
        flags: fromJson(input.understanding.flags),
        extracted: fromJson(input.understanding.extracted),
        summary: input.understanding.summary,
        model: input.model,
        prompt_version: input.promptVersion,
        latency_ms: input.latencyMs,
        attempt: input.attempt,
        created_at: clock.nowIso(),
        question_asked: input.understanding.questionAsked,
        model_output: fromJson(input.modelOutput),
        validation: fromJson(input.validation),
        security: fromJson(input.security),
      };

      const { sql, params } = buildInsert('email_analyses', values);
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM email_analyses WHERE id = ?', [values.id]);
      return mapAnalysis(rows[0] as Record<string, unknown>);
    },

    async getById(id: string): Promise<AnalysisRecord | null> {
      const rows = await db.query('SELECT * FROM email_analyses WHERE id = ?', [id]);
      return rows[0] ? mapAnalysis(rows[0]) : null;
    },

    /** The current reading of an email — the newest analysis. */
    async getLatestForEmail(emailId: string): Promise<AnalysisRecord | null> {
      const rows = await db.query(
        'SELECT * FROM email_analyses WHERE email_id = ? ORDER BY created_at DESC, attempt DESC LIMIT 1',
        [emailId],
      );
      return rows[0] ? mapAnalysis(rows[0]) : null;
    },

    /**
     * The latest analysis for many emails, in one query (M7-F).
     *
     * The inbox used to call `getLatestForEmail` once per row. At ten emails
     * that was ten round trips, and a round trip to a hosted database is the
     * expensive part — not the query.
     */
    async getLatestForEmails(emailIds: readonly string[]): Promise<Map<string, AnalysisRecord>> {
      const latest = new Map<string, AnalysisRecord>();
      if (emailIds.length === 0) return latest;

      const rows = await db.query(
        `SELECT * FROM email_analyses WHERE email_id IN (${emailIds.map(() => '?').join(', ')})
         ORDER BY created_at DESC, attempt DESC`,
        [...emailIds],
      );
      // Ordered newest-first, so the first row seen for an email is its latest.
      for (const row of rows) {
        const analysis = mapAnalysis(row);
        if (!latest.has(analysis.emailId)) latest.set(analysis.emailId, analysis);
      }
      return latest;
    },

    /** Every reading, newest first — the history of how understanding changed. */
    async listForEmail(emailId: string): Promise<AnalysisRecord[]> {
      const rows = await db.query(
        'SELECT * FROM email_analyses WHERE email_id = ? ORDER BY created_at DESC',
        [emailId],
      );
      return rows.map(mapAnalysis);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM email_analyses');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type AnalysisRepository = ReturnType<typeof createAnalysisRepository>;
