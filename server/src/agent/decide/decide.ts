import { evaluateRules, buildRationale, type DecisionContext } from './rules.ts';
import { buildDraftMessages, buildDraftSystemPrompt, validateDraft, DRAFT_TOOL, DRAFT_PROMPT_VERSION } from './draftPrompt.ts';
import { buildGroundingText, checkDraft } from './draftGuardrails.ts';
import { requiresApproval } from '../policy/approval.ts';
import { planRiskTier } from '../../domain/actions.ts';
import { isDraftable, type ActionPlan, type DecisionRecord, type Draft } from '../../domain/decision.ts';
import { runToResolution } from '../resolve/resolve.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import type { EmailRecord, ReviewReason } from '../../domain/email.ts';
import type { LlmProvider } from '../../adapters/llm/types.ts';
import { AppError } from '../../lib/errors.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';

// STAGE 2 — DECIDE (spec §7).
//
//   understanding + resolution + CRM + settings
//     → rules            deterministic; produces the action plan and its trace
//     → policy           requiresApproval(), the M0 function, unchanged
//     → draft            model writes prose, only when a reply is warranted
//     → guardrails       deterministic post-checks on that prose
//     → policy again     a blocked draft forces approval (§16)
//     → persist          plan, trace, policy reasons, draft, all separately
//     → state            awaiting_approval | deciding | needs_review
//
// M3 ENDS AT A PERSISTED DECISION. Nothing here writes to the CRM, queues an
// email, or executes anything — that is M4, behind the approval gate.
//
// WHERE THE MODEL SITS: after the plan is final. It receives a finished
// decision and writes the covering text. It has one tool, `record_draft`, which
// records two strings. There is no code path by which its output can add an
// action, change a risk tier, or clear an approval requirement.

export type DecideOutcome = {
  email: EmailRecord;
  decision: DecisionRecord | null;
  plan: ActionPlan | null;
  state: EmailRecord['state'];
  reviewReason: ReviewReason | null;
};

export type DecideDeps = {
  repos: Repositories;
  provider: LlmProvider;
  logger?: Logger;
  clock?: Clock;
};

/**
 * Guards which states may enter DECIDE.
 *
 * `deciding` is where M2 leaves a resolved email. `awaiting_approval` is
 * allowed so a decision can be re-run and superseded before anyone acts on it.
 */
export function assertDecidable(email: EmailRecord): void {
  const allowed = ['deciding', 'awaiting_approval'];
  if (!allowed.includes(email.state)) {
    throw new AppError(
      'INVALID_STATE',
      `This email cannot be decided while it is ${email.state.replace(/_/g, ' ')}.`,
    );
  }
}

export async function decideEmail(
  email: EmailRecord,
  { repos, provider, logger = createLogger('decide'), clock = systemClock }: DecideDeps,
): Promise<DecideOutcome> {
  const analysis = await repos.analyses.getLatestForEmail(email.id);
  if (!analysis) {
    throw new AppError('INVALID_STATE', 'This email has not been analysed yet.');
  }

  const contactRun = await repos.entityMatches.getLatestRun(email.id, 'contact');
  const companyRun = await repos.entityMatches.getLatestRun(email.id, 'company');
  const contact = runToResolution('contact', contactRun);
  const company = runToResolution('company', companyRun);

  // --- CRM context the rules need -------------------------------------------

  const matchedContact =
    contact.selectedEntityId === null ? null : await repos.contacts.getById(contact.selectedEntityId);

  let openDeal = null;
  if (company.selectedEntityId !== null) {
    const deals = await repos.deals.listByCompany(company.selectedEntityId);
    openDeal =
      deals.filter((deal) => deal.stage !== 'won' && deal.stage !== 'lost').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  const ctx: DecisionContext = {
    email,
    understanding: analysis.understanding,
    contact,
    company,
    openDeal,
    matchedContact,
    now: clock.nowIso(),
  };

  // --- the plan, from rules only --------------------------------------------

  const evaluation = evaluateRules(ctx);
  const riskTier = planRiskTier(evaluation.actions);
  const settings = await repos.settings.getAll();

  // --- the draft, when a reply is warranted ---------------------------------

  let draft: Draft | null = null;
  let draftFailedReason: string | null = null;
  let model: string | null = null;
  let latencyMs: number | null = null;

  const wantsReply = evaluation.actions.some((action) => action.type === 'send_email');
  if (wantsReply && isDraftable(analysis.understanding.category)) {
    const grounding = buildGroundingText(email, analysis.understanding, settings.business_profile);

    try {
      const response = await provider.complete({
        purpose: 'draft',
        promptVersion: DRAFT_PROMPT_VERSION,
        systemPrompt: buildDraftSystemPrompt(settings.business_profile),
        messages: buildDraftMessages(email, analysis.understanding, evaluation.actions),
        tool: DRAFT_TOOL,
        maxTokens: 1024,
        metadata: { fixtureId: `${email.providerMessageId}:draft` },
      });

      model = response.model;
      latencyMs = response.latencyMs;

      const validated = validateDraft(response.toolInput);
      if (!validated.ok) {
        // Unusable output is not a partially-usable draft. There is no repair
        // retry here: unlike UNDERSTAND, nothing downstream depends on the text
        // existing, so the honest outcome is "a person writes this one".
        draftFailedReason = `The drafted reply could not be read: ${validated.problems.join('; ')}.`;
      } else {
        const guardrails = checkDraft({
          draftSubject: validated.subject,
          draftBody: validated.body,
          groundingText: grounding,
          understanding: analysis.understanding,
          senderEmail: email.fromEmail,
          businessName: settings.business_profile.name,
        });

        draft = {
          subject: validated.subject,
          body: validated.body,
          guardrailsPassed: guardrails.passed,
          blockedBy: guardrails.violations,
        };
      }
    } catch (err) {
      // A drafting failure never fails the decision: the plan is deterministic
      // and already computed. The email goes to a person to write the reply
      // rather than losing the work that was already done.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Drafting failed', { emailId: email.id, provider: provider.name, internal: message });
      draftFailedReason = 'The drafting provider could not be reached, so no reply was written.';
    }
  }

  // --- the policy gate, unchanged from M0 -----------------------------------

  const violations = draft?.blockedBy.map((violation) => violation.guardrail) ?? [];
  // A draft that could not be written is treated like a blocked one for the
  // purpose of the gate: either way there is no reply a machine may send.
  const draftProblems = draftFailedReason !== null ? [...violations, 'draft_unavailable'] : violations;

  const approval = requiresApproval({
    actions: evaluation.actions,
    autonomyLevel: settings.autonomy_level,
    confidenceBand: analysis.understanding.confidenceBand,
    flags: analysis.understanding.flags,
    hasMatchConflict: contact.verdict === 'MATCH_CONFLICT' || company.verdict === 'MATCH_CONFLICT',
    draftGuardrailViolations: draftProblems,
    adapterSupportsAtomicity: true,
  });

  const plan: ActionPlan = {
    actions: evaluation.actions,
    riskTier,
    requiresApproval: approval.required,
    approvalReasons: approval.reasons,
    rationale: buildRationale(ctx, evaluation),
    ruleTrace: evaluation.trace,
    draft,
    draftFailedReason,
  };

  // --- persist ---------------------------------------------------------------
  //
  // CLAIM THE EMAIL BEFORE WRITING ANYTHING (M7-F)
  //
  // `handleDecidePending` selects every email in `deciding`, and nothing used
  // to stop two overlapping batches selecting the same rows. Each then created
  // its own decision, superseding the other's, and production ended up with
  // emails carrying three decisions apiece and pending approvals that could
  // never be actioned.
  //
  // The claim is a compare-and-swap out of `deciding` — the same mechanism the
  // expiry sweep already uses — and it happens FIRST. Ordering is the whole
  // point: a claim taken after the decision was written would detect the loser
  // only once the duplicate row already existed. A batch that loses the race
  // writes nothing at all and reports that it did not win.
  //
  // `nextState` is computed here rather than further down for the same reason:
  // the claim needs to know where the email is going.
  const { state, reviewReason } = nextState(plan);

  // Compare against the state this run actually read, not a hardcoded one:
  // `assertDecidable` also permits re-deciding from `awaiting_approval`, and
  // pinning the guard to `deciding` turned every legitimate re-decide into a
  // silent no-op. The guarantee wanted here is "nothing has moved since I
  // looked", which is exactly `expectedFrom: email.state`.
  const claimed = await repos.emails.setState(email.id, state, { reviewReason, expectedFrom: email.state });
  if (claimed === null) {
    logger.info('Another run decided this email first; writing nothing.', { emailId: email.id });
    const current = (await repos.emails.getById(email.id)) as EmailRecord;
    return { email: current, decision: null, plan: null, state: current.state, reviewReason: current.reviewReason };
  }

  const decision = await repos.decisions.create({
    emailId: email.id,
    analysisId: analysis.id,
    resolutionRun: contactRun[0]?.resolutionRun ?? companyRun[0]?.resolutionRun ?? null,
    plan,
    model,
    promptVersion: draft !== null || draftFailedReason !== null ? DRAFT_PROMPT_VERSION : null,
    latencyMs,
  });

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'decide',
    eventType: 'plan_created',
    actor: 'system',
    outcome: plan.actions.length === 0 ? 'skipped' : 'ok',
    summary: plan.rationale,
    payload: {
      actions: plan.actions.map((action) => action.type),
      riskTier: plan.riskTier,
      rulesFired: plan.ruleTrace.filter((entry) => entry.fired).map((entry) => entry.rule),
    },
    entityType: 'decision',
    entityId: decision.id,
  });

  if (draft !== null) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'decide',
      eventType: draft.blockedBy.length > 0 ? 'draft_blocked' : 'draft_generated',
      actor: 'ai',
      actorId: model,
      outcome: draft.blockedBy.length > 0 ? 'blocked' : 'ok',
      summary:
        draft.blockedBy.length > 0
          ? `The drafted reply was blocked by ${draft.blockedBy.map((v) => v.guardrail).join(', ')}. A person must rewrite it.`
          : `Drafted a reply that passed all ${draft.guardrailsPassed.length} content checks.`,
      payload: {
        guardrailsPassed: draft.guardrailsPassed,
        blockedBy: draft.blockedBy.map((violation) => violation.guardrail),
        promptVersion: DRAFT_PROMPT_VERSION,
      },
      latencyMs,
      entityType: 'decision',
      entityId: decision.id,
    });
  }

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'policy',
    eventType: 'policy_evaluated',
    actor: 'system',
    outcome: approval.required ? 'blocked' : 'ok',
    summary: approval.required
      ? `Approval required: ${approval.reasons.map((reason) => reason.message).join(' ')}`
      : 'No approval required for this plan.',
    payload: {
      riskTier: plan.riskTier,
      requiresApproval: approval.required,
      reasons: approval.reasons.map((reason) => reason.code),
      autonomyLevel: settings.autonomy_level,
    },
    entityType: 'decision',
    entityId: decision.id,
  });

  // --- state -----------------------------------------------------------------
  //
  // Already claimed above; `updated` is the row that claim returned.

  if (state === 'awaiting_approval') {
    // Open the approval request now, so the SLA clock starts when the plan was
    // made rather than when someone happens to look at it (§16). Idempotent by
    // the schema's UNIQUE(decision_id).
    await repos.approvals.request(decision.id, settings.approval_sla_hours);

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'approval',
      eventType: 'approval_requested',
      actor: 'system',
      outcome: 'ok',
      summary: 'Waiting for a person to approve this plan.',
      payload: { decisionId: decision.id, riskTier: plan.riskTier },
      entityType: 'decision',
      entityId: decision.id,
    });
  }

  const updated = claimed;
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'decide',
    eventType: 'state_changed',
    actor: 'system',
    outcome: 'ok',
    summary:
      state === 'needs_review'
        ? 'Routed to human review: no action could be recommended.'
        : state === 'awaiting_approval'
          ? 'A plan is ready and waiting for approval.'
          : 'A plan is ready to run unattended.',
    payload: { state, reviewReason },
  });

  logger.info('Decision complete', {
    emailId: email.id,
    actions: plan.actions.length,
    riskTier: plan.riskTier,
    requiresApproval: plan.requiresApproval,
    state,
  });

  return {
    email: updated ?? ((await repos.emails.getById(email.id)) as EmailRecord),
    decision,
    plan,
    state,
    reviewReason,
  };
}

/**
 * Where the email rests after a decision.
 *
 * Three outcomes, and note the third: a plan that needs no approval stays in
 * `deciding`. The §8 state machine sends it to `executing`, but M3 does not
 * execute — moving it there would leave the email claiming something is
 * happening when nothing is. M4 makes that transition when it can honour it.
 */
export function nextState(plan: ActionPlan): { state: EmailRecord['state']; reviewReason: ReviewReason | null } {
  if (plan.actions.length === 0) {
    return { state: 'needs_review', reviewReason: 'no_valid_plan' };
  }
  if (plan.requiresApproval) {
    return { state: 'awaiting_approval', reviewReason: null };
  }
  return { state: 'deciding', reviewReason: null };
}
