import { validateEditEnvelope, type EditDiffEntry } from './editEnvelope.ts';
import { checkDraft, buildGroundingText } from '../decide/draftGuardrails.ts';
import { requiresApproval, type ApprovalReason } from '../policy/approval.ts';
import { runToResolution } from '../resolve/resolve.ts';
import { planRiskTier } from '../../domain/actions.ts';
import type { ApprovalRecord } from '../../domain/execution.ts';
import { stableHash } from '../../lib/ids.ts';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import type { ActionPlan, DecisionRecord, Draft } from '../../domain/decision.ts';
import type { Repositories } from '../../db/repositories/index.ts';

// THE REVISION ENGINE (M4-C, FR-23, FR-26).
//
// A human edits a plan. The plan they edited does not change.
//
// That sentence is the whole design. An edit produces a NEW decision — v2, with
// `origin='human_edit'` and a parent — while v1 keeps saying exactly what the
// model proposed, because v1 paired with v2 *is* the labelled correction that
// §20's feedback loop is built from. Editing in place would throw away the more
// valuable half of the record to save a row.
//
// WHAT THIS MODULE DOES NOT DO
//
// It does not execute anything, and it does not approve anything. It ends with a
// pending approval on v2, which then goes through the same approval endpoint and
// the same executor as any other plan. There is no second execution path, and
// that is deliberate: a bypass grows in the second implementation of a check,
// not in the first.
//
// THE ORDER OF OPERATIONS IS LOAD-BEARING
//
//   1. eligibility   — is this plan even editable right now?
//   2. validation    — is every edit inside the whitelist?
//   3. guardrails    — is the edited reply safe to put in front of a customer?
//   4. policy        — does the revision still need a human, floored at v1?
//   5. one transaction — v2, v1's approval superseded, v2's approval, audit.
//
// Steps 1–4 write nothing (with one deliberate exception: a guardrail refusal is
// audited, because an attempt to send unsafe text is exactly what an audit log
// is for). So every refusal leaves v1 pending and untouched.

export type ReviseDeps = {
  repos: Repositories;
  clock?: Clock;
  logger?: Logger;
};

export type ReviseResult = {
  decision: DecisionRecord;
  approval: ApprovalRecord;
  supersededApproval: ApprovalRecord;
  parentDecisionId: string;
  revision: number;
  diff: EditDiffEntry[];
};

/** Why an edit was refused before anything was written. A closed set, asserted by name in tests. */
export const REVISE_REFUSAL_CODES = [
  'decision_superseded',
  'approval_missing',
  'approval_not_pending',
  'already_executed',
  'email_executing',
  'risk_tier_lowered',
] as const;
export type ReviseRefusalCode = (typeof REVISE_REFUSAL_CODES)[number];

function refuse(code: ReviseRefusalCode, message: string): AppError {
  return new AppError('INVALID_STATE', message, { details: { refusedWith: code } });
}

/**
 * Whether a plan may be edited at all.
 *
 * The rule is narrow on purpose: **a pending approval and no execution rows**.
 * Anything else has either already been decided by a person or has already
 * changed the CRM, and in the second case a revision would be actively
 * dangerous — idempotency keys are derived from the decision id (§15), so a
 * revision's actions carry *fresh* keys and would re-apply every write that
 * already succeeded.
 */
export async function assertEditable(
  decision: DecisionRecord,
  repos: Repositories,
): Promise<ApprovalRecord> {
  if (decision.supersededBy !== null) {
    throw refuse('decision_superseded', 'This plan was replaced by a newer one and can no longer be edited.');
  }

  const email = await repos.emails.getById(decision.emailId);
  if (!email) throw new NotFoundError('Email');

  if (email.state === 'executing') {
    throw refuse('email_executing', 'This plan is being applied right now and cannot be edited.');
  }

  const executions = await repos.executions.listForDecision(decision.id);
  if (executions.length > 0) {
    throw refuse(
      'already_executed',
      'This plan has already started changing the CRM, so it can no longer be edited. ' +
        'Anything further needs a new decision, not a revision of this one.',
    );
  }

  const approval = await repos.approvals.getForDecision(decision.id);
  if (!approval) {
    throw refuse('approval_missing', 'This plan is not waiting for approval, so there is nothing to edit.');
  }
  if (approval.state !== 'pending') {
    throw refuse(
      'approval_not_pending',
      `This plan was already ${approval.state}${approval.decidedBy ? ` by ${approval.decidedBy}` : ''} and can no longer be edited.`,
    );
  }

  return approval;
}

/**
 * Creates a revision of a decision from a human's edits.
 *
 * Every safety-relevant fact is re-derived from the database. Nothing about
 * risk, approval or authority is read from the request: the caller supplies
 * edits and an identity, and that is all it is trusted for.
 */
export async function reviseDecision(
  decisionId: string,
  input: { edits: unknown; editedBy: string },
  { repos, clock = systemClock, logger = createLogger('revise') }: ReviseDeps,
): Promise<ReviseResult> {
  const now = clock.nowIso();

  const decision = await repos.decisions.getById(decisionId);
  if (!decision) throw new NotFoundError('Decision');

  // 1. Eligibility, before a single field is looked at.
  const currentApproval = await assertEditable(decision, repos);

  const email = await repos.emails.getById(decision.emailId);
  if (!email) throw new NotFoundError('Email');

  const analysis = await repos.analyses.getLatestForEmail(email.id);
  const settings = await repos.settings.getAll();

  // 2. Validation. Throws a ValidationError naming every bad path, having
  //    written nothing.
  const edits = validateEditEnvelope(input.edits, decision.plan, now);

  // 3. Guardrails, on the edited text only. The same six checks the model's
  //    draft faced, run by the same function against the same grounding — a
  //    human may rewrite the reply, but not to something the business would not
  //    have been allowed to say automatically.
  let draft: Draft | null = edits.draft;

  if (edits.draftEdited && draft !== null) {
    if (!analysis) {
      throw refuse('approval_missing', 'This reply cannot be edited because the email was never analysed.');
    }

    const guardrails = checkDraft({
      draftSubject: draft.subject,
      draftBody: draft.body,
      // Rebuilt from the original email, the stored analysis and the business
      // profile — the same three sources §7 allows a draft to draw on. An edit
      // may not widen what counts as grounded.
      groundingText: buildGroundingText(email, analysis.understanding, settings.business_profile),
      understanding: analysis.understanding,
      senderEmail: email.fromEmail,
      businessName: settings.business_profile.name,
    });

    if (!guardrails.safe) {
      // Audited, then refused. This write is deliberately outside the
      // transaction below — there is no transaction yet, and the record of an
      // unsafe edit must survive the refusal that follows it.
      await repos.audit.append({
        correlationId: email.correlationId,
        emailId: email.id,
        stage: 'decide',
        eventType: 'draft_edit_blocked',
        actor: 'human',
        actorId: input.editedBy,
        outcome: 'blocked',
        summary: `An edited reply was blocked by ${guardrails.violations.map((v) => v.guardrail).join(', ')} and was not saved.`,
        // Guardrail names only — never the offending text, which is drawn from
        // the customer's own email.
        payload: {
          decisionId: decision.id,
          blockedBy: guardrails.violations.map((violation) => violation.guardrail),
        },
        entityType: 'decision',
        entityId: decision.id,
      });

      logger.warn('Edited draft blocked', {
        decisionId: decision.id,
        blockedBy: guardrails.violations.map((violation) => violation.guardrail),
      });

      throw new ValidationError(
        guardrails.violations.map((violation) => `${violation.guardrail}: ${violation.why}`),
        'That reply was blocked by the same content checks the AI draft has to pass, so nothing was saved.',
      );
    }

    draft = { ...draft, guardrailsPassed: guardrails.passed, blockedBy: [] };
  }

  // 4. Policy, recomputed from stored facts. The request contributes edits and
  //    an identity; it does not get a vote on whether the result is safe.
  const riskTier = planRiskTier(edits.actions);
  if (riskTier < decision.plan.riskTier) {
    // Unreachable while the action set is fixed, which it is — an edit can only
    // change whitelisted content fields. If it ever happens, something in the
    // registry or the envelope is wrong, and the safe response is to refuse
    // rather than to proceed with less authority than the plan started with.
    throw refuse(
      'risk_tier_lowered',
      'This edit would lower the risk tier of the plan, which an edit may never do.',
    );
  }

  const contact = runToResolution('contact', await repos.entityMatches.getLatestRun(email.id, 'contact'));
  const company = runToResolution('company', await repos.entityMatches.getLatestRun(email.id, 'company'));

  const recomputed = requiresApproval({
    actions: edits.actions,
    autonomyLevel: settings.autonomy_level,
    ...(analysis
      ? { confidenceBand: analysis.understanding.confidenceBand, flags: analysis.understanding.flags }
      : {}),
    hasMatchConflict: contact.verdict === 'MATCH_CONFLICT' || company.verdict === 'MATCH_CONFLICT',
    draftGuardrailViolations: draft?.blockedBy.map((violation) => violation.guardrail) ?? [],
    adapterSupportsAtomicity: true,
  });

  // The floor. Editing can raise the bar and can never lower it — including
  // when the autonomy setting was loosened between the original and the edit.
  const approvalReasons: ApprovalReason[] = [...recomputed.reasons];
  const required = decision.plan.requiresApproval || recomputed.required;

  if (required && !recomputed.required) {
    approvalReasons.push({
      code: 'inherited_from_original',
      message:
        'The plan this was edited from needed approval, so this one does too. ' +
        'An edit can add a reason a human is needed; it can never remove one.',
    });
  }

  const revisedPlan: ActionPlan = {
    ...decision.plan,
    actions: edits.actions,
    riskTier,
    requiresApproval: required,
    approvalReasons,
    draft,
  };

  // 5. One transaction. Repositories are rebound to it, so this is atomic on
  //    both drivers rather than only on the one that happens to share a
  //    connection.
  const result = await repos.transaction(async (tx) => {
    const revision = await tx.decisions.create({
      emailId: decision.emailId,
      analysisId: decision.analysisId,
      resolutionRun: decision.resolutionRun,
      plan: revisedPlan,
      model: decision.model,
      promptVersion: decision.promptVersion,
      latencyMs: decision.latencyMs,
      origin: 'human_edit',
      parentDecisionId: decision.id,
      editedBy: input.editedBy,
    });

    // v1's approval stops being pending. It is not rejected — nobody rejected
    // it — and it did not expire. It was superseded, and the record says so.
    const superseded = await tx.approvals.decide(decision.id, 'superseded', {
      decidedBy: 'system',
      reason: `Replaced by revision ${revision.revision}, edited by ${input.editedBy}.`,
    });

    // v2's own approval: pending, with a full SLA window, bound to v2 alone.
    const approval = await tx.approvals.request(revision.id, settings.approval_sla_hours);

    await tx.approvals.recordEdit(revision.id, {
      editedActions: edits.actions,
      editedDraft: draft === null ? null : { subject: draft.subject, body: draft.body },
      editDiff: edits.diff,
    });

    await tx.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'decide',
      eventType: 'plan_revised',
      actor: 'human',
      actorId: input.editedBy,
      outcome: 'ok',
      summary: `${input.editedBy} edited ${edits.diff.length} field(s); this is revision ${revision.revision}.`,
      // Paths and a digest, never values: an edited draft body quotes the
      // customer's email, and §19 keeps message content out of the audit log.
      payload: {
        fromDecisionId: decision.id,
        toDecisionId: revision.id,
        revision: revision.revision,
        editedBy: input.editedBy,
        changedPaths: edits.diff.map((entry) => entry.path),
        diffDigest: stableHash(edits.diff),
        requiresApproval: required,
        riskTier,
      },
      entityType: 'decision',
      entityId: revision.id,
    });

    await tx.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'approval',
      eventType: 'approval_superseded',
      actor: 'system',
      outcome: 'blocked',
      summary: `The approval request for the previous plan was superseded by revision ${revision.revision}.`,
      payload: { decisionId: decision.id, supersededBy: revision.id, previousApprovalId: currentApproval.id },
      entityType: 'decision',
      entityId: decision.id,
    });

    return { revision, approval, superseded };
  });

  // The email goes back to awaiting_approval: there is a pending approval again,
  // on a different plan. Outside the transaction because it is a consequence of
  // the revision rather than part of it, and it is idempotent.
  await repos.emails.setState(email.id, 'awaiting_approval');

  logger.info('Plan revised', {
    emailId: email.id,
    fromDecisionId: decision.id,
    toDecisionId: result.revision.id,
    revision: result.revision.revision,
    changed: edits.diff.length,
  });

  return {
    decision: result.revision,
    approval: result.approval,
    supersededApproval: result.superseded,
    parentDecisionId: decision.id,
    revision: result.revision.revision,
    diff: edits.diff,
  };
}
