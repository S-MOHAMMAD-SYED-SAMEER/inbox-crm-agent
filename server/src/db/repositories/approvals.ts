import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toJson, fromJson } from '../rows.ts';
import { ConflictError, NotFoundError } from '../../lib/errors.ts';
import { APPROVAL_STATES } from '../../domain/execution.ts';
import type { ApprovalRecord, ApprovalState } from '../../domain/execution.ts';

// Approval persistence (spec §16, FR-22..FR-25).
//
// The lifecycle is `pending → approved | rejected | expired | superseded`, and
// the terminal states are terminal: `decide()` below refuses to move an
// approval that has already been settled. That matters because a second
// approval on the same decision would make "who authorised this, and when?"
// ambiguous — and the whole point of the record is that it is not.
//
// `superseded` (M4-C) is reached when a human edits the plan: the edit creates
// a new decision with its own approval, so this one stops being pending without
// anyone having rejected it and without anything having timed out.
//
// Note what this repository does NOT expose: no way to set a state directly,
// no update method, no delete. The only transitions available are the ones the
// lifecycle allows.

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: toText(row.id),
    decisionId: toText(row.decision_id),
    state: toText(row.state) as ApprovalState,
    decidedBy: toTextOrNull(row.decided_by),
    decidedAt: toTextOrNull(row.decided_at),
    reason: toTextOrNull(row.reason),
    planHash: toTextOrNull(row.plan_hash),
    expiresAt: toText(row.expires_at),
    createdAt: toText(row.created_at),
  };
}

export function createApprovalRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Opens a pending approval for a decision.
     *
     * Idempotent by the schema's UNIQUE(decision_id): asking twice returns the
     * existing request rather than opening a second one. Re-deciding produces a
     * *new* decision, which gets its own approval — so an approval can never
     * straddle two versions of a plan.
     */
    async request(decisionId: string, slaHours: number): Promise<ApprovalRecord> {
      const existing = await this.getForDecision(decisionId);
      if (existing) return existing;

      const now = clock.nowIso();
      const values = {
        id: newId(),
        decision_id: decisionId,
        state: 'pending' satisfies ApprovalState,
        decided_by: null,
        decided_at: null,
        reason: null,
        edited_actions: null,
        edited_draft: null,
        edit_diff: null,
        expires_at: new Date(Date.parse(now) + slaHours * 3600_000).toISOString(),
        created_at: now,
        plan_hash: null,
      };

      const { sql, params } = buildInsert('approvals', values);
      await db.execute(sql, params);
      return (await this.getForDecision(decisionId)) as ApprovalRecord;
    },

    async getForDecision(decisionId: string): Promise<ApprovalRecord | null> {
      const rows = await db.query('SELECT * FROM approvals WHERE decision_id = ?', [decisionId]);
      return rows[0] ? mapApproval(rows[0]) : null;
    },

    async getById(id: string): Promise<ApprovalRecord | null> {
      const rows = await db.query('SELECT * FROM approvals WHERE id = ?', [id]);
      return rows[0] ? mapApproval(rows[0]) : null;
    },

    /**
     * Settles a pending approval.
     *
     * `planHash` is stored on approval so the executor can prove later that the
     * plan it is about to run is the plan that was read. A rejection stores the
     * reason, which is required — "rejected" with no explanation teaches
     * nobody anything.
     *
     * The state guard is in the WHERE clause rather than in a read-then-write,
     * so two concurrent approvals cannot both succeed.
     *
     * All four destinations are terminal, and the guard below is what makes
     * them so: `pending` is the only state this method will move out of. That
     * is why `superseded` (M4-C) needs no separate protection — an approval
     * that has been superseded can no more be approved than a rejected one can.
     */
    async decide(
      decisionId: string,
      next: Extract<ApprovalState, 'approved' | 'rejected' | 'expired' | 'superseded'>,
      options: { decidedBy: string; reason?: string | null; planHash?: string | null } = { decidedBy: 'operator' },
    ): Promise<ApprovalRecord> {
      const current = await this.getForDecision(decisionId);
      if (!current) throw new NotFoundError('Approval');
      if (current.state !== 'pending') {
        throw new ConflictError(
          `This decision was already ${current.state}${current.decidedBy ? ` by ${current.decidedBy}` : ''}.`,
          { state: current.state },
        );
      }

      const result = await db.execute(
        `UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, reason = ?, plan_hash = ?
         WHERE decision_id = ? AND state = 'pending'`,
        [next, options.decidedBy, clock.nowIso(), options.reason ?? null, options.planHash ?? null, decisionId],
      );
      if (result.rowCount === 0) {
        throw new ConflictError('This decision was settled by someone else while you were deciding.');
      }

      return (await this.getForDecision(decisionId)) as ApprovalRecord;
    },

    /**
     * Records what a human changed, on the approval for the revision (FR-26).
     *
     * These three columns have existed since M0 and were written as NULL until
     * now. They are the eval signal §20's feedback loop is built on: the AI's
     * proposal, the human's final version, and the structured difference
     * between them — a labelled model error in the client's own domain.
     *
     * Write-once. The guard is in the WHERE clause, so a second attempt to
     * record an edit against the same approval changes nothing rather than
     * overwriting the first — the diff is evidence, and evidence is not
     * something a later call gets to revise.
     */
    async recordEdit(
      decisionId: string,
      edit: { editedActions: unknown; editedDraft: unknown; editDiff: unknown },
    ): Promise<ApprovalRecord> {
      const result = await db.execute(
        `UPDATE approvals SET edited_actions = ?, edited_draft = ?, edit_diff = ?
         WHERE decision_id = ? AND edit_diff IS NULL`,
        [
          fromJson(edit.editedActions),
          edit.editedDraft === null ? null : fromJson(edit.editedDraft),
          fromJson(edit.editDiff),
          decisionId,
        ],
      );
      if (result.rowCount === 0) {
        const existing = await this.getForDecision(decisionId);
        if (!existing) throw new NotFoundError('Approval');
        throw new ConflictError('This approval already records an edit.');
      }

      return (await this.getForDecision(decisionId)) as ApprovalRecord;
    },

    /** The stored edit for an approval, or null when it was approved unmodified. */
    async getEdit(
      decisionId: string,
    ): Promise<{ editedActions: unknown; editedDraft: unknown; editDiff: unknown } | null> {
      const rows = await db.query(
        'SELECT edited_actions, edited_draft, edit_diff FROM approvals WHERE decision_id = ?',
        [decisionId],
      );
      const row = rows[0];
      if (!row || row.edit_diff === null || row.edit_diff === undefined) return null;

      return {
        editedActions: toJson<unknown>(row.edited_actions, null),
        editedDraft: toJson<unknown>(row.edited_draft, null),
        editDiff: toJson<unknown>(row.edit_diff, null),
      };
    },

    async listByState(state: ApprovalState, limit = 100): Promise<ApprovalRecord[]> {
      const rows = await db.query(
        'SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC LIMIT ?',
        [state, Math.min(limit, 500)],
      );
      return rows.map(mapApproval);
    },

    /** Pending approvals whose SLA has elapsed. Expiry never executes (§16). */
    async listExpired(now: string, limit = 100): Promise<ApprovalRecord[]> {
      const rows = await db.query(
        "SELECT * FROM approvals WHERE state = 'pending' AND expires_at < ? ORDER BY expires_at LIMIT ?",
        [now, Math.min(limit, 500)],
      );
      return rows.map(mapApproval);
    },

    /**
     * How many approvals sit in each state (M5-F, audit F-11).
     *
     * One aggregate query. The previous implementation called
     * `listByState(state, 500).length` once per state — up to 2,500 full rows
     * fetched to produce five integers, and silently *wrong* past 500 because
     * the count inherited the page limit. A number on a dashboard that quietly
     * stops counting is worse than a slow one.
     */
    async countByState(): Promise<Record<ApprovalState, number>> {
      const rows = await db.query<{ state: string; n: number }>(
        'SELECT state, COUNT(*) AS n FROM approvals GROUP BY state',
      );

      // Every state present, including the ones with nothing in them: a missing
      // key and a zero mean the same thing to a reader, and only one of them
      // survives JSON round-tripping intact.
      const counts = Object.fromEntries(APPROVAL_STATES.map((state) => [state, 0])) as Record<ApprovalState, number>;
      for (const row of rows) {
        const state = toText(row.state) as ApprovalState;
        if (state in counts) counts[state] = Number(row.n);
      }
      return counts;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM approvals');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type ApprovalRepository = ReturnType<typeof createApprovalRepository>;
