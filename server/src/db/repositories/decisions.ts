import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toNumberOrNull, toBool, toJson, fromJson } from '../rows.ts';
import { NotFoundError } from '../../lib/errors.ts';
import type { ProposedAction, RiskTier } from '../../domain/actions.ts';
import type { ApprovalReason } from '../../agent/policy/approval.ts';
import type {
  ActionPlan,
  DecisionOrigin,
  DecisionRecord,
  Draft,
  DraftGuardrailViolation,
  RuleTraceEntry,
} from '../../domain/decision.ts';

// Decision persistence (M3).
//
// Append-only in practice, like analyses and resolutions. Re-deciding writes a
// NEW decision and marks the previous one `superseded_by` — it never edits it.
// That is what makes "what did it recommend before the human corrected the
// category, and what changed?" answerable, and it is the same rule the audit
// log follows for the same reason.
//
// M4-C adds a second reason for a new row: a human editing the plan. That takes
// the same path — new decision, old one superseded, nothing edited in place —
// and records `origin`, `parent_decision_id`, `revision` and `edited_by` so the
// history says who changed what, and from what.
//
// The five kinds of knowledge stay in their own columns: the deterministic plan
// (`actions`, `risk_tier`, `rule_trace`), the policy result (`requires_approval`,
// `approval_reasons`), the model's prose (`draft_subject`, `draft_body`), what
// the guardrails made of it (`draft_guardrails_passed`, `draft_blocked_by`),
// and what it was all based on (`analysis_id`, `resolution_run`).

function mapDecision(row: Record<string, unknown>): DecisionRecord {
  const subject = toTextOrNull(row.draft_subject);
  const body = toTextOrNull(row.draft_body);

  const draft: Draft | null =
    subject === null || body === null
      ? null
      : {
          subject,
          body,
          guardrailsPassed: toJson<string[]>(row.draft_guardrails_passed, []),
          blockedBy: toJson<DraftGuardrailViolation[]>(row.draft_blocked_by, []),
        };

  const plan: ActionPlan = {
    actions: toJson<ProposedAction[]>(row.actions, []),
    riskTier: toNumber(row.risk_tier) as RiskTier,
    requiresApproval: toBool(row.requires_approval),
    approvalReasons: toJson<ApprovalReason[]>(row.approval_reasons, []),
    rationale: toText(row.rationale),
    ruleTrace: toJson<RuleTraceEntry[]>(row.rule_trace, []),
    draft,
    draftFailedReason: toTextOrNull(row.draft_failed_reason),
  };

  return {
    id: toText(row.id),
    emailId: toText(row.email_id),
    analysisId: toText(row.analysis_id),
    resolutionRun: toTextOrNull(row.resolution_run),
    plan,
    model: toTextOrNull(row.model),
    promptVersion: toTextOrNull(row.prompt_version),
    latencyMs: toNumberOrNull(row.latency_ms),
    supersededBy: toTextOrNull(row.superseded_by),
    parentDecisionId: toTextOrNull(row.parent_decision_id),
    revision: toNumber(row.revision),
    origin: toText(row.origin) as DecisionOrigin,
    editedBy: toTextOrNull(row.edited_by),
    createdAt: toText(row.created_at),
  };
}

export type CreateDecisionInput = {
  emailId: string;
  analysisId: string;
  resolutionRun: string | null;
  plan: ActionPlan;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  /**
   * Revision provenance (M4-C). Omitted entirely for an agent decision, which
   * is why the defaults live here rather than at every call site.
   */
  origin?: DecisionOrigin;
  parentDecisionId?: string | null;
  editedBy?: string | null;
};

export function createDecisionRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Writes a decision, superseding any previous one for this email.
     *
     * Both writes happen in one transaction: a superseded pointer with no
     * successor, or a successor with the old decision still looking current,
     * would each make the history lie. The revision number is counted inside
     * that same transaction for the same reason — read outside it, two
     * concurrent decisions would both call themselves v2.
     *
     * A human edit (M4-C) comes through here too, as a *new* row. There is no
     * update path on this repository and there must not be one: the original
     * proposal is evidence, and the whole point of a revision is that the thing
     * it revises still says what it said.
     */
    async create(input: CreateDecisionInput): Promise<DecisionRecord> {
      const id = newId();
      const { plan } = input;
      const origin: DecisionOrigin = input.origin ?? 'agent';
      const parentDecisionId = input.parentDecisionId ?? null;
      const editedBy = input.editedBy ?? null;

      // Provenance has to be coherent, and this repository is the only writer,
      // so it is checked here rather than trusted from a caller. An edit with
      // no parent could not be traced back to what it changed; an agent
      // decision with an editor would be a lie about who made it.
      if (origin === 'human_edit') {
        if (parentDecisionId === null) throw new Error('A human edit must record the decision it was edited from.');
        if (editedBy === null) throw new Error('A human edit must record who made it.');
      } else if (parentDecisionId !== null || editedBy !== null) {
        throw new Error('An agent decision has no parent and no editor.');
      }

      if (parentDecisionId !== null) {
        const parent = await this.getById(parentDecisionId);
        if (!parent) throw new NotFoundError('Parent decision');
        if (parent.emailId !== input.emailId) {
          throw new Error('A revision must belong to the same email as the decision it revises.');
        }
      }

      await db.transaction(async (tx) => {
        const counted = await tx.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM decisions WHERE email_id = ?',
          [input.emailId],
        );

        const values = {
          id,
          email_id: input.emailId,
          analysis_id: input.analysisId,
          actions: fromJson(plan.actions),
          risk_tier: plan.riskTier,
          requires_approval: plan.requiresApproval,
          rationale: plan.rationale,
          rule_trace: fromJson(plan.ruleTrace),
          draft_subject: plan.draft?.subject ?? null,
          draft_body: plan.draft?.body ?? null,
          draft_blocked_by: fromJson(plan.draft?.blockedBy ?? []),
          model: input.model,
          prompt_version: input.promptVersion,
          latency_ms: input.latencyMs,
          superseded_by: null,
          created_at: clock.nowIso(),
          resolution_run: input.resolutionRun,
          approval_reasons: fromJson(plan.approvalReasons),
          draft_guardrails_passed: fromJson(plan.draft?.guardrailsPassed ?? []),
          draft_failed_reason: plan.draftFailedReason,
          parent_decision_id: parentDecisionId,
          revision: Number(counted[0]?.n ?? 0) + 1,
          origin,
          edited_by: editedBy,
        };

        const { sql, params } = buildInsert('decisions', values);
        await tx.execute(sql, params);

        await tx.execute(
          'UPDATE decisions SET superseded_by = ? WHERE email_id = ? AND id != ? AND superseded_by IS NULL',
          [id, input.emailId, id],
        );
      });

      const rows = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
      return mapDecision(rows[0] as Record<string, unknown>);
    },

    async getById(id: string): Promise<DecisionRecord | null> {
      const rows = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
      return rows[0] ? mapDecision(rows[0]) : null;
    },

    /** The decision in force — the one nothing has superseded. */
    async getCurrentForEmail(emailId: string): Promise<DecisionRecord | null> {
      const rows = await db.query(
        'SELECT * FROM decisions WHERE email_id = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 1',
        [emailId],
      );
      return rows[0] ? mapDecision(rows[0]) : null;
    },

    /** Every decision ever made for this email, newest first. */
    async listForEmail(emailId: string): Promise<DecisionRecord[]> {
      const rows = await db.query(
        'SELECT * FROM decisions WHERE email_id = ? ORDER BY created_at DESC',
        [emailId],
      );
      return rows.map(mapDecision);
    },

    async listAwaitingApproval(limit = 100): Promise<DecisionRecord[]> {
      const rows = await db.query(
        `SELECT * FROM decisions WHERE requires_approval = ? AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT ?`,
        [true, Math.min(limit, 500)],
      );
      return rows.map(mapDecision);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM decisions');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type DecisionRepository = ReturnType<typeof createDecisionRepository>;
