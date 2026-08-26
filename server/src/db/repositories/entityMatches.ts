import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toBool } from '../rows.ts';
import type {
  Candidate,
  EntityResolution,
  MatchMethod,
  ResolutionOutcome,
  ResolutionRecord,
  ResolvableEntityType,
} from '../../domain/resolution.ts';

// Resolution persistence (M2).
//
// Append-only in practice, like analyses: a re-resolution writes a new run
// rather than editing the old one, and `getLatestForEmail` returns the newest.
// That matters more here than it looks, because the common reason to re-resolve
// is that a human just settled a conflict — and the record of what the system
// originally thought, next to what the person chose, is the most valuable
// signal this stage produces.
//
// One row per candidate considered. The run's verdict (`outcome`) is repeated
// on each row of the run: it describes the decision, not the candidate, and
// storing it per row keeps every candidate self-describing when read alone.
// `selected` marks the winner — a conflict run has none, which is the point.

function mapRow(row: Record<string, unknown>): ResolutionRecord {
  return {
    id: toText(row.id),
    emailId: toText(row.email_id),
    analysisId: toTextOrNull(row.analysis_id),
    resolutionRun: toText(row.resolution_run),
    entityType: toText(row.entity_type) as ResolvableEntityType,
    entityId: toTextOrNull(row.entity_id),
    score: toNumber(row.score),
    method: toText(row.method) as MatchMethod,
    evidence: toText(row.evidence),
    outcome: toText(row.outcome) as ResolutionOutcome,
    rank: toNumber(row.rank),
    selected: toBool(row.selected),
    reason: toText(row.reason),
    createdAt: toText(row.created_at),
  };
}

export type RecordResolutionInput = {
  emailId: string;
  analysisId: string | null;
  resolutionRun: string;
  resolution: EntityResolution;
};

export function createEntityMatchRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Writes one resolution run for one entity type.
     *
     * A run with no candidates still writes a row — with a null entity id and
     * the `propose_create` outcome — because "we looked and found nothing" is a
     * result worth recording. Storing nothing would make a considered NO_MATCH
     * indistinguishable from a stage that never ran.
     */
    async recordResolution(input: RecordResolutionInput): Promise<ResolutionRecord[]> {
      const { resolution } = input;
      const now = clock.nowIso();
      const written: ResolutionRecord[] = [];

      const rows: Array<{ candidate: Candidate | null; rank: number }> =
        resolution.candidates.length > 0
          ? resolution.candidates.map((candidate, index) => ({ candidate, rank: index + 1 }))
          : [{ candidate: null, rank: 1 }];

      await db.transaction(async (tx) => {
        for (const { candidate, rank } of rows) {
          const values = {
            id: newId(),
            email_id: input.emailId,
            entity_type: resolution.entityType,
            entity_id: candidate?.entityId ?? null,
            score: candidate?.score ?? 0,
            method: candidate?.method ?? 'name_only',
            evidence: candidate?.evidence ?? resolution.reason,
            outcome: resolution.outcome,
            created_at: now,
            resolution_run: input.resolutionRun,
            analysis_id: input.analysisId,
            rank,
            selected: candidate !== null && candidate.entityId === resolution.selectedEntityId,
            reason: resolution.reason,
          };

          const { sql, params } = buildInsert('entity_matches', values);
          await tx.execute(sql, params);

          const inserted = await tx.query('SELECT * FROM entity_matches WHERE id = ?', [values.id]);
          written.push(mapRow(inserted[0] as Record<string, unknown>));
        }
      });

      return written;
    },

    /** Every candidate row of the most recent run for this email and entity type. */
    async getLatestRun(emailId: string, entityType: ResolvableEntityType): Promise<ResolutionRecord[]> {
      const latest = await db.query<{ resolution_run: string }>(
        `SELECT resolution_run FROM entity_matches
         WHERE email_id = ? AND entity_type = ?
         ORDER BY created_at DESC, rank ASC LIMIT 1`,
        [emailId, entityType],
      );
      const run = latest[0]?.resolution_run;
      if (!run) return [];

      // Filtered by entity_type as well as run: contact and company rows share
      // one resolution_run, so a run-only filter returns both and every caller
      // silently reads the wrong verdict.
      const rows = await db.query(
        'SELECT * FROM entity_matches WHERE resolution_run = ? AND entity_type = ? ORDER BY rank',
        [run, entityType],
      );
      return rows.map(mapRow);
    },

    /**
     * The latest run per entity type for many emails, in ONE query (M7-F).
     *
     * This was the inbox's most expensive lookup by far: `getLatestRun` costs
     * two round trips (find the newest run, then read it) and the inbox called
     * it twice per email — 36 of the 57 round trips a ten-email load used to
     * make.
     *
     * One query fetches every match row for the emails in question, newest
     * first, and the grouping happens here. The rule is unchanged and still
     * matters: contact and company rows SHARE a `resolution_run`, so a run has
     * to be selected per entity type or every caller reads the wrong verdict.
     */
    async getLatestRunsForEmails(
      emailIds: readonly string[],
    ): Promise<Map<string, { contact: ResolutionRecord[]; company: ResolutionRecord[] }>> {
      const byEmail = new Map<string, { contact: ResolutionRecord[]; company: ResolutionRecord[] }>();
      if (emailIds.length === 0) return byEmail;

      const rows = await db.query(
        `SELECT * FROM entity_matches WHERE email_id IN (${emailIds.map(() => '?').join(', ')})
         ORDER BY created_at DESC, rank ASC`,
        [...emailIds],
      );

      // First row seen for an (email, entityType) names that pair's latest run,
      // because the ordering is newest-first. Later rows join it only if they
      // belong to the same run.
      const chosenRun = new Map<string, string>();
      for (const row of rows) {
        const record = mapRow(row);
        const key = `${record.emailId}:${record.entityType}`;
        if (!chosenRun.has(key)) chosenRun.set(key, record.resolutionRun);
        if (chosenRun.get(key) !== record.resolutionRun) continue;

        const entry = byEmail.get(record.emailId) ?? { contact: [], company: [] };
        if (record.entityType === 'contact') entry.contact.push(record);
        else entry.company.push(record);
        byEmail.set(record.emailId, entry);
      }

      // `getLatestRun` returns rows ordered by rank; preserve that.
      for (const entry of byEmail.values()) {
        entry.contact.sort((a, b) => a.rank - b.rank);
        entry.company.sort((a, b) => a.rank - b.rank);
      }
      return byEmail;
    },

    /** The latest run for every entity type, flattened — powers the detail screen. */
    async listLatestForEmail(emailId: string): Promise<ResolutionRecord[]> {
      const contact = await this.getLatestRun(emailId, 'contact');
      const company = await this.getLatestRun(emailId, 'company');
      return [...contact, ...company];
    },

    /**
     * Rows that actually established a link. Used for the thread bonus, so only
     * genuine links count — a conflict candidate is not a link.
     */
    async listSelectedForEmail(emailId: string): Promise<ResolutionRecord[]> {
      const rows = await db.query(
        `SELECT * FROM entity_matches
         WHERE email_id = ? AND selected = ? AND entity_id IS NOT NULL
         ORDER BY created_at DESC`,
        [emailId, true],
      );
      return rows.map(mapRow);
    },

    async listForEmail(emailId: string): Promise<ResolutionRecord[]> {
      const rows = await db.query(
        'SELECT * FROM entity_matches WHERE email_id = ? ORDER BY created_at DESC, rank ASC',
        [emailId],
      );
      return rows.map(mapRow);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM entity_matches');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type EntityMatchRepository = ReturnType<typeof createEntityMatchRepository>;
