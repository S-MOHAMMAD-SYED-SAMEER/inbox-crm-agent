import { EMAIL_STATES, type EmailState } from '../domain/email.ts';
import { AppError, NotFoundError, ValidationError } from '../lib/errors.ts';
import {
  ProblemCollector,
  optionalInteger,
  optionalOneOf,
  requireObject,
  requireOneOf,
  requireString,
} from '../lib/validate.ts';
import { ingestEmails } from '../agent/ingest/ingest.ts';
import { understandEmail, assertUnderstandable } from '../agent/understand/understand.ts';
import {
  resolveEmail,
  resolveMatchByHuman,
  runToResolution,
  enrichCandidateLabels,
  assertResolvable,
} from '../agent/resolve/resolve.ts';
import { RESOLVABLE_ENTITY_TYPES, type EntityResolution } from '../domain/resolution.ts';
import { APPROVAL_STATES } from '../domain/execution.ts';
import { decideEmail, assertDecidable, type DecideOutcome } from '../agent/decide/decide.ts';
import { executePlan } from '../agent/execute/executor.ts';
import { sweepExpiredApprovals, isOverdue } from '../agent/approve/expiry.ts';
import { reviseDecision } from '../agent/revise/revise.ts';
import type { EditDiffEntry } from '../agent/revise/editEnvelope.ts';
import { planFingerprint } from '../domain/execution.ts';
import type { DecisionRecord } from '../domain/decision.ts';
import type { ApprovalRecord, ApprovalState, ExecutionRecord, OutboxRecord } from '../domain/execution.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { EmailSource } from '../adapters/email/types.ts';
import type { LlmProvider } from '../adapters/llm/types.ts';
import type { Logger } from '../lib/logger.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import type { AnalysisRecord } from '../domain/understanding.ts';
import type { EmailRecord } from '../domain/email.ts';
import type { AuditEvent } from '../domain/audit.ts';

// M1 handlers.
//
// Same shape as M0's health handler and Project 1's `handleChat`: a plain
// function returning `{ status, body }`, with every dependency injected. The
// Express routes are three-line wrappers, so all of this is testable with an
// in-memory database and a mock provider — no HTTP server, no port, no key.
//
// Only the endpoints M1 actually needs exist. There is no `/process`, no
// `/approve`, and no CRM route, because the stages behind them are not built:
// an endpoint that returns "not implemented" is a promise the UI will start
// depending on.

export type EmailHandlerDeps = {
  repos: Repositories;
  source: EmailSource;
  provider: LlmProvider;
  logger?: Logger;
};

export type HandlerResult<T> = { status: number; body: T };

// ------------------------------------------------------------------ ingest

export async function handleIngest(
  deps: EmailHandlerDeps,
  input: unknown = {},
): Promise<HandlerResult<{ ingested: number; duplicates: number; emails: EmailSummary[] }>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const limit = optionalInteger(body.limit, 'limit', problems, { min: 1, max: 200 });
  const since = body.since === undefined || body.since === null ? undefined : String(body.since);
  problems.throwIfAny();

  const result = await ingestEmails(deps, {
    ...(since === undefined ? {} : { since }),
    ...(limit === null ? {} : { limit }),
  });

  return {
    status: 200,
    body: {
      ingested: result.ingested.length,
      duplicates: result.duplicates,
      // Wrapped rather than passed by reference: `Array.map` supplies an index
      // as the second argument, which would land in the `analysis` parameter.
      emails: result.ingested.map((email) => toSummary(email)),
    },
  };
}

// -------------------------------------------------------------------- list

export type EmailSummary = {
  id: string;
  fromName: string | null;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  state: EmailState;
  reviewReason: string | null;
  analysis: {
    category: string;
    priority: string;
    confidence: number;
    confidenceBand: string;
    summary: string;
    injectionSuspected: boolean;
    droppedFieldCount: number;
  } | null;
  /** Null until resolution has run — never a fabricated verdict. */
  resolution: { contact: string; company: string } | null;
  /** Null until a decision exists. Never a placeholder recommendation. */
  decision: {
    actionCount: number;
    riskTier: number;
    requiresApproval: boolean;
    hasDraft: boolean;
    draftBlocked: boolean;
  } | null;
};

function toSummary(
  email: EmailRecord,
  analysis?: AnalysisRecord | null,
  resolution?: { contact: string; company: string } | null,
  decision?: DecisionRecord | null,
): EmailSummary {
  return {
    id: email.id,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    subject: email.subject,
    receivedAt: email.receivedAt,
    state: email.state,
    reviewReason: email.reviewReason,
    analysis: analysis
      ? {
          category: analysis.understanding.category,
          priority: analysis.understanding.priority,
          confidence: analysis.understanding.confidence,
          confidenceBand: analysis.understanding.confidenceBand,
          summary: analysis.understanding.summary,
          injectionSuspected: analysis.security.injection.suspected,
          droppedFieldCount: analysis.validation.droppedFields.length,
        }
      : null,
    resolution: resolution ?? null,
    decision: decision
      ? {
          actionCount: decision.plan.actions.length,
          riskTier: decision.plan.riskTier,
          requiresApproval: decision.plan.requiresApproval,
          hasDraft: decision.plan.draft !== null,
          draftBlocked: (decision.plan.draft?.blockedBy.length ?? 0) > 0,
        }
      : null,
  };
}

/** The verdict pair for a list row, or null when resolution has not run. */
async function resolutionSummary(
  repos: Repositories,
  emailId: string,
): Promise<{ contact: string; company: string } | null> {
  const contact = await repos.entityMatches.getLatestRun(emailId, 'contact');
  const company = await repos.entityMatches.getLatestRun(emailId, 'company');
  if (contact.length === 0 && company.length === 0) return null;
  return {
    contact: runToResolution('contact', contact).verdict,
    company: runToResolution('company', company).verdict,
  };
}

export async function handleListEmails(
  deps: Pick<EmailHandlerDeps, 'repos'>,
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ emails: EmailSummary[] }>> {
  const problems = new ProblemCollector();
  const state = optionalOneOf(query.state, 'state', EMAIL_STATES, problems);
  const limit = optionalInteger(numeric(query.limit), 'limit', problems, { min: 1, max: 200 });
  const offset = optionalInteger(numeric(query.offset), 'offset', problems, { min: 0 });
  problems.throwIfAny();

  const emails = await deps.repos.emails.list({
    ...(state === null ? {} : { state }),
    ...(limit === null ? {} : { limit }),
    ...(offset === null ? {} : { offset }),
  });

  // Four queries, whatever the inbox length (M7-F).
  //
  // This used to look up the analysis, both resolution runs and the decision
  // once per email: 57 round trips for ten emails. Against a hosted database
  // the round trip is the cost, not the query, and the inbox took seconds to
  // appear. The comment that stood here said a set-based query was the right
  // answer "once the inbox is long enough for it to matter" — ten emails and a
  // remote database turned out to be long enough.
  //
  // Same response shape, same values; only the number of trips changed.
  const ids = emails.map((email) => email.id);
  const [analyses, resolutions, decisions] = await Promise.all([
    deps.repos.analyses.getLatestForEmails(ids),
    deps.repos.entityMatches.getLatestRunsForEmails(ids),
    deps.repos.decisions.getCurrentForEmails(ids),
  ]);

  const summaries = emails.map((email) => {
    const runs = resolutions.get(email.id);
    // Unchanged rule: no runs at all means the email has not been resolved, and
    // that is reported as null rather than as two empty verdicts.
    const resolution =
      runs === undefined || (runs.contact.length === 0 && runs.company.length === 0)
        ? null
        : {
            contact: runToResolution('contact', runs.contact).verdict,
            company: runToResolution('company', runs.company).verdict,
          };

    return toSummary(email, analyses.get(email.id) ?? null, resolution, decisions.get(email.id) ?? null);
  });

  return { status: 200, body: { emails: summaries } };
}

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

// ------------------------------------------------------------------ detail

/**
 * One entry in an email's decision history (M4-C.3).
 *
 * The plan itself is deliberately absent: this is the spine of the history —
 * who produced each version and where it ended up — not a second copy of every
 * plan the email ever had. The current revision's plan is already on `decision`,
 * and a screen that needs an older plan should ask for it rather than have
 * every list carry it.
 */
export type DecisionRevision = {
  id: string;
  revision: number;
  origin: DecisionRecord['origin'];
  editedBy: string | null;
  parentDecisionId: string | null;
  createdAt: string;
  /** Null when the plan never needed an approval at all. */
  approvalState: ApprovalState | null;
  /** True for the one decision nothing has superseded. */
  isCurrent: boolean;
};

export type EmailDetail = {
  email: EmailRecord;
  analysis: AnalysisRecord | null;
  /** Null until resolution has run. Never a placeholder verdict. */
  resolution: { contact: EntityResolution; company: EntityResolution } | null;
  /** Null until DECIDE has run. Never a placeholder recommendation. */
  decision: DecisionRecord | null;
  /** Null until a plan needed approval. */
  approval: ApprovalRecord | null;
  /**
   * Every decision made for this email, oldest first (M4-C.3).
   *
   * Always at least one entry once DECIDE has run. A human edit appends a new
   * one rather than replacing the previous — that pairing is the point (FR-26),
   * so the history is a first-class part of the detail rather than something
   * the UI reconstructs from the audit log.
   */
  revisions: DecisionRevision[];
  /** Empty until something has actually been applied. */
  executions: ExecutionRecord[];
  /** The suppressed reply, when one was queued. Never sent. */
  outbox: OutboxRecord | null;
  audit: AuditEvent[];
  /**
   * What the later stages would show, and why they do not yet. Stated
   * explicitly rather than omitted, so the UI never has to guess whether an
   * empty decision means "not built" or "nothing recommended" (§ API/UI).
   */
  stages: {
    understand: 'complete' | 'pending' | 'failed';
    resolve: 'complete' | 'pending' | 'conflict';
    decide: 'complete' | 'pending' | 'no_plan';
    execute: 'pending' | 'awaiting_approval' | 'complete' | 'failed' | 'rejected';
  };
};

export async function handleGetEmail(
  deps: Pick<EmailHandlerDeps, 'repos'>,
  id: string,
): Promise<HandlerResult<EmailDetail>> {
  const email = await deps.repos.emails.getById(id);
  if (!email) throw new NotFoundError('Email');

  const analysis = await deps.repos.analyses.getLatestForEmail(id);
  const audit = await deps.repos.audit.listByEmail(id);

  const contactRun = await deps.repos.entityMatches.getLatestRun(id, 'contact');
  const companyRun = await deps.repos.entityMatches.getLatestRun(id, 'company');
  const hasResolution = contactRun.length > 0 || companyRun.length > 0;
  const resolution = hasResolution
    ? {
        contact: await enrichCandidateLabels(deps.repos, runToResolution('contact', contactRun)),
        company: await enrichCandidateLabels(deps.repos, runToResolution('company', companyRun)),
      }
    : null;

  const conflicted =
    resolution !== null &&
    (resolution.contact.outcome === 'conflict' || resolution.company.outcome === 'conflict');

  const decision = await deps.repos.decisions.getCurrentForEmail(id);
  const approval = decision === null ? null : await deps.repos.approvals.getForDecision(decision.id);

  // Oldest first: a history reads forwards. `listForEmail` returns newest first
  // because every other caller wants the latest, so it is reversed here rather
  // than adding a second query that differs only in ORDER BY.
  const history = [...(await deps.repos.decisions.listForEmail(id))].reverse();
  const revisions: DecisionRevision[] = [];
  for (const entry of history) {
    const entryApproval = await deps.repos.approvals.getForDecision(entry.id);
    revisions.push({
      id: entry.id,
      revision: entry.revision,
      origin: entry.origin,
      editedBy: entry.editedBy,
      parentDecisionId: entry.parentDecisionId,
      createdAt: entry.createdAt,
      approvalState: entryApproval?.state ?? null,
      isCurrent: entry.supersededBy === null,
    });
  }
  const executions = decision === null ? [] : await deps.repos.executions.listForDecision(decision.id);
  const outbox = decision === null ? null : await deps.repos.outbox.findForDecision(decision.id);

  const executeStage =
    email.state === 'completed' || email.state === 'archived'
      ? 'complete'
      : email.state === 'execution_failed'
        ? 'failed'
        : approval?.state === 'rejected'
          ? 'rejected'
          : email.state === 'awaiting_approval'
            ? 'awaiting_approval'
            : 'pending';

  return {
    status: 200,
    body: {
      email,
      analysis,
      resolution,
      decision,
      approval,
      revisions,
      executions,
      outbox,
      audit,
      stages: {
        understand: analysis ? 'complete' : email.state === 'understand_failed' ? 'failed' : 'pending',
        resolve: conflicted ? 'conflict' : hasResolution ? 'complete' : 'pending',
        decide: decision === null ? 'pending' : decision.plan.actions.length === 0 ? 'no_plan' : 'complete',
        execute: executeStage,
      },
    },
  };
}

// ----------------------------------------------------------------- resolve

export async function handleResolveEmail(deps: EmailHandlerDeps, id: string): Promise<HandlerResult<EmailDetail>> {
  const email = await deps.repos.emails.getById(id);
  if (!email) throw new NotFoundError('Email');

  assertResolvable(email);
  await resolveEmail(email, deps);
  return handleGetEmail(deps, id);
}

/** Runs resolution over everything UNDERSTAND has finished with. */
export async function handleResolvePending(
  deps: EmailHandlerDeps,
  input: unknown = {},
): Promise<HandlerResult<{ resolved: number; conflicts: number; failed: number; results: EmailSummary[] }>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const limit = optionalInteger(body.limit, 'limit', problems, { min: 1, max: 100 });
  problems.throwIfAny();

  const pending = await deps.repos.emails.list({ state: 'resolving', limit: limit ?? 50 });

  let resolved = 0;
  let conflicts = 0;
  let failed = 0;
  const results: EmailSummary[] = [];

  for (const email of pending) {
    try {
      const outcome = await resolveEmail(email, deps);
      resolved++;
      if (outcome.reviewReason === 'match_conflict') conflicts++;
      results.push(
        toSummary(outcome.email, await deps.repos.analyses.getLatestForEmail(email.id), {
          contact: outcome.contact.verdict,
          company: outcome.company.verdict,
        }),
      );
    } catch (err) {
      // One email failing must not abandon the batch.
      failed++;
      deps.logger?.error('Resolving an email threw', {
        emailId: email.id,
        internal: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: 200, body: { resolved, conflicts, failed, results } };
}

/** Records a human's decision on a conflicted match (spec §11 `/resolve-match`). */
export async function handleResolveMatch(
  deps: EmailHandlerDeps,
  id: string,
  input: unknown,
  operator: string,
): Promise<HandlerResult<EmailDetail>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const entityType = requireOneOf(body.entityType, 'entityType', RESOLVABLE_ENTITY_TYPES, problems);

  // "create_new" is spelled out rather than being an absent field, so "the
  // operator decided this is a new record" is never confused with "the field
  // was forgotten".
  const rawEntityId = body.entityId;
  let entityId: string | null = null;
  if (rawEntityId !== 'create_new') {
    entityId = requireString(rawEntityId, 'entityId', problems);
  }
  problems.throwIfAny();

  const email = await deps.repos.emails.getById(id);
  if (!email) throw new NotFoundError('Email');

  await resolveMatchByHuman(email, { entityType, entityId, decidedBy: operator }, deps);
  return handleGetEmail(deps, id);
}

// -------------------------------------------------------------- understand

// ------------------------------------------------------------------ decide

/**
 * Runs a plan that needs no approval (M6-E).
 *
 * WHY THIS IS HERE AND NOT IN `decideEmail`
 *
 * `nextState` leaves an unattended plan in `deciding` and says why: the §8 state
 * machine sends it to `executing`, but M3 could not execute, and moving an email
 * to `executing` when nothing would happen would have been a lie. The comment
 * ends "M4 makes that transition when it can honour it." M4 shipped the
 * executor and nothing came back for this, so tier-0 plans have been sitting in
 * `deciding` ever since — decided, never run, and invisible in the approval
 * queue because they need no approval.
 *
 * The pipeline is the right place for it. §14 puts the branch at the policy
 * gate, after the plan is persisted, and handlers are what orchestrate stages —
 * `decideEmail` calling the executor directly would invert the layering and
 * make DECIDE depend on EXECUTE.
 *
 * NOTHING IS WEAKENED BY THIS
 *
 * This calls exactly the path the "Run this plan" button already called, with
 * the same deps and no flag that says "skip the checks". `verifyExecutable`
 * recomputes the approval policy from stored facts and treats the plan's own
 * `requiresApproval` as a floor, never a permission — so a plan that reaches
 * here claiming it needs no approval is still refused if the policy disagrees.
 * The condition below is a cheap pre-filter, not the gate. The gate is in the
 * executor, where it has always been.
 *
 * Returns whether the plan actually ran.
 */
async function runIfUnattended(deps: EmailHandlerDeps, outcome: DecideOutcome): Promise<boolean> {
  // Only the unattended branch. `awaiting_approval` waits for a person and
  // `needs_review` has no plan to run. A decision that produced no plan at all
  // has nothing to execute either.
  if (outcome.state !== 'deciding') return false;
  if (outcome.decision === null || outcome.plan === null) return false;
  if (outcome.plan.requiresApproval) return false;
  if (outcome.plan.actions.length === 0) return false;

  const decision = outcome.decision;

  try {
    const executed = await executePlan(outcome.email, decision, deps);
    if (!executed.ok) {
      // A refusal is a real answer, not a crash: the executor disagreed with
      // the plan. The email keeps its state and a person can still run it.
      deps.logger?.info('An unattended plan was refused by the executor', {
        emailId: outcome.email.id,
        decisionId: decision.id,
        refusedWith: executed.refusedWith,
      });
    }
    return executed.ok;
  } catch (err) {
    // Never let running the plan destroy the decision that was just made.
    deps.logger?.error('Running an unattended plan threw', {
      emailId: outcome.email.id,
      internal: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function handleDecideEmail(deps: EmailHandlerDeps, id: string): Promise<HandlerResult<EmailDetail>> {
  const email = await deps.repos.emails.getById(id);
  if (!email) throw new NotFoundError('Email');

  assertDecidable(email);
  const outcome = await decideEmail(email, deps);
  await runIfUnattended(deps, outcome);
  return handleGetEmail(deps, id);
}

/** Runs DECIDE over everything resolution has finished with. */
export async function handleDecidePending(
  deps: EmailHandlerDeps,
  input: unknown = {},
): Promise<
  HandlerResult<{
    decided: number;
    awaitingApproval: number;
    /** Plans that needed no approval and were run immediately (M6-E). */
    autoExecuted: number;
    noPlan: number;
    failed: number;
    results: EmailSummary[];
  }>
> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const limit = optionalInteger(body.limit, 'limit', problems, { min: 1, max: 100 });
  problems.throwIfAny();

  const pending = await deps.repos.emails.list({ state: 'deciding', limit: limit ?? 50 });

  let decided = 0;
  let awaitingApproval = 0;
  let autoExecuted = 0;
  let noPlan = 0;
  let failed = 0;
  const results: EmailSummary[] = [];

  for (const email of pending) {
    try {
      const outcome = await decideEmail(email, deps);
      decided++;
      if (outcome.state === 'awaiting_approval') awaitingApproval++;
      if (outcome.state === 'needs_review') noPlan++;

      // A plan needing no approval runs now rather than resting in `deciding`.
      if (await runIfUnattended(deps, outcome)) autoExecuted++;

      // Re-read: running the plan moved the email on, and the summary must
      // report where it actually ended up rather than where DECIDE left it.
      const settled = (await deps.repos.emails.getById(email.id)) ?? outcome.email;

      results.push(
        toSummary(
          settled,
          await deps.repos.analyses.getLatestForEmail(email.id),
          await resolutionSummary(deps.repos, email.id),
          outcome.decision,
        ),
      );
    } catch (err) {
      // One email failing must not abandon the batch.
      failed++;
      deps.logger?.error('Deciding an email threw', {
        emailId: email.id,
        internal: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: 200, body: { decided, awaitingApproval, autoExecuted, noPlan, failed, results } };
}

// -------------------------------------------------- approval and execution

/**
 * Loads the decision an approval/execution request names, refusing anything
 * that does not line up. The id in the URL is a claim, not a fact.
 */
async function loadDecision(deps: EmailHandlerDeps, decisionId: string) {
  const decision = await deps.repos.decisions.getById(decisionId);
  if (!decision) throw new NotFoundError('Decision');

  const email = await deps.repos.emails.getById(decision.emailId);
  if (!email) throw new NotFoundError('Email');

  return { decision, email };
}

/** What a successful revision returns (M4-C). */
export type ReviseResponse = {
  decision: DecisionRecord;
  revision: number;
  parentDecisionId: string;
  /** The new pending approval, bound to the revision alone. */
  approval: ApprovalRecord;
  /** The previous approval, now terminal. */
  supersededApproval: ApprovalRecord;
  diff: EditDiffEntry[];
  detail: EmailDetail;
};

export type ExecutionResponse = {
  ok: boolean;
  refusedWith: string | null;
  refusalMessage: string | null;
  executed: number;
  outboxStatus: string | null;
  detail: EmailDetail;
};

/**
 * Approves a plan and runs it (spec §11: approve "→ executes").
 *
 * The body carries no authority: there is no field a caller can set to say the
 * plan was approved, what its risk is, or whether approval was needed. The
 * approval becomes real because a row is written here, and the executor then
 * re-derives everything for itself.
 */
export async function handleApprove(
  deps: EmailHandlerDeps,
  decisionId: string,
  operator: string,
): Promise<HandlerResult<ExecutionResponse>> {
  const { decision, email } = await loadDecision(deps, decisionId);

  if (decision.supersededBy !== null) {
    throw new AppError('INVALID_STATE', 'This plan was replaced by a newer one and can no longer be approved.');
  }

  const settings = await deps.repos.settings.getAll();
  await deps.repos.approvals.request(decision.id, settings.approval_sla_hours);

  // The fingerprint is taken from the stored plan, not from anything the
  // client sent, so it records what was actually approved.
  await deps.repos.approvals.decide(decision.id, 'approved', {
    decidedBy: operator,
    planHash: planFingerprint(decision.plan),
  });

  await deps.repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'approval',
    eventType: 'approval_granted',
    actor: 'human',
    actorId: operator,
    outcome: 'ok',
    summary: `${operator} approved this plan.`,
    payload: { decisionId: decision.id, riskTier: decision.plan.riskTier },
    entityType: 'decision',
    entityId: decision.id,
  });

  const outcome = await executePlan(email, decision, deps);
  const detail = await handleGetEmail(deps, email.id);

  return {
    status: 200,
    body: {
      ok: outcome.ok,
      refusedWith: outcome.refusedWith,
      refusalMessage: outcome.refusalMessage,
      executed: outcome.executions.filter((e) => e.status === 'succeeded').length,
      outboxStatus: outcome.outbox?.status ?? null,
      detail: detail.body,
    },
  };
}

/** Rejects a plan. A reason is required — "rejected" with no explanation teaches nobody anything. */
export async function handleReject(
  deps: EmailHandlerDeps,
  decisionId: string,
  input: unknown,
  operator: string,
): Promise<HandlerResult<EmailDetail>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const reason = requireString(body.reason, 'reason', problems, { maxLength: 1000 });
  problems.throwIfAny();

  const { decision, email } = await loadDecision(deps, decisionId);
  const settings = await deps.repos.settings.getAll();
  await deps.repos.approvals.request(decision.id, settings.approval_sla_hours);
  await deps.repos.approvals.decide(decision.id, 'rejected', { decidedBy: operator, reason });

  await deps.repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'approval',
    eventType: 'approval_rejected',
    actor: 'human',
    actorId: operator,
    outcome: 'blocked',
    summary: `${operator} rejected this plan: ${reason}`,
    payload: { decisionId: decision.id },
    entityType: 'decision',
    entityId: decision.id,
  });

  await deps.repos.emails.setState(email.id, 'rejected');
  return handleGetEmail(deps, email.id);
}

/**
 * Runs a plan that needs no approval, or retries a failed one.
 *
 * Safe to expose because it grants nothing: the executor re-runs the approval
 * policy from stored facts and refuses if approval is required and missing.
 * Calling this on a tier-2 plan does not execute it.
 */
export async function handleExecute(
  deps: EmailHandlerDeps,
  decisionId: string,
): Promise<HandlerResult<ExecutionResponse>> {
  const { decision, email } = await loadDecision(deps, decisionId);
  const outcome = await executePlan(email, decision, deps);
  const detail = await handleGetEmail(deps, email.id);

  return {
    status: 200,
    body: {
      ok: outcome.ok,
      refusedWith: outcome.refusedWith,
      refusalMessage: outcome.refusalMessage,
      executed: outcome.executions.filter((e) => e.status === 'succeeded').length,
      outboxStatus: outcome.outbox?.status ?? null,
      detail: detail.body,
    },
  };
}

/** The approval queue (spec §11). */
/** One row of the approval queue — everything §13.4 asks a reviewer to see. */
export type ApprovalQueueRow = {
  approval: ApprovalRecord;
  decision: DecisionRecord;
  email: {
    id: string;
    subject: string;
    fromName: string | null;
    fromEmail: string;
    receivedAt: string;
    state: string;
  };
  /** The one-line recommendation, for the collapsed row. */
  recommendation: string;
  riskTier: number;
  /** From the analysis, when there is one. */
  confidence: number | null;
  confidenceBand: string | null;
  /** Milliseconds until the window closes. Negative once it has passed. */
  msToExpiry: number;
  /** Milliseconds since the plan was made. */
  ageMs: number;
  /** True once the window has closed, whether or not the sweep has run. */
  overdue: boolean;
  /**
   * Whether a person can still act on this row. An overdue approval is never
   * actionable — the executor would refuse it anyway (M4-A), and showing it as
   * pending work would be a lie.
   */
  actionable: boolean;
  hasDraft: boolean;
  draftBlocked: boolean;
};

/**
 * The approval queue (spec §11, §13.4).
 *
 * Sorted by SLA remaining, soonest first — the spec's ordering, not a score of
 * my invention. Settled rows (approved/rejected/expired) have no SLA left to
 * run down, so they are ordered by when they were decided, newest first.
 */
export async function handleListApprovals(
  deps: Pick<EmailHandlerDeps, 'repos'> & { clock?: Clock },
  query: Record<string, unknown> = {},
): Promise<HandlerResult<{ approvals: ApprovalQueueRow[]; counts: Record<string, number> }>> {
  const problems = new ProblemCollector();
  const state = optionalOneOf(query.state, 'state', APPROVAL_STATES, problems);
  problems.throwIfAny();

  const now = (deps.clock ?? systemClock).nowIso();
  const nowMs = Date.parse(now);
  const wanted = state ?? 'pending';

  const rows: ApprovalQueueRow[] = [];
  for (const approval of await deps.repos.approvals.listByState(wanted, 200)) {
    const decision = await deps.repos.decisions.getById(approval.decisionId);
    if (!decision) continue;
    const email = await deps.repos.emails.getById(decision.emailId);
    if (!email) continue;

    const analysis = await deps.repos.analyses.getLatestForEmail(email.id);
    const overdue = isOverdue(approval, now);

    rows.push({
      approval,
      decision,
      email: {
        id: email.id,
        subject: email.subject,
        fromName: email.fromName,
        fromEmail: email.fromEmail,
        receivedAt: email.receivedAt,
        state: email.state,
      },
      recommendation: decision.plan.rationale,
      riskTier: decision.plan.riskTier,
      confidence: analysis?.understanding.confidence ?? null,
      confidenceBand: analysis?.understanding.confidenceBand ?? null,
      msToExpiry: Date.parse(approval.expiresAt) - nowMs,
      ageMs: nowMs - Date.parse(approval.createdAt),
      overdue,
      actionable: approval.state === 'pending' && !overdue,
      hasDraft: decision.plan.draft !== null,
      draftBlocked: (decision.plan.draft?.blockedBy.length ?? 0) > 0,
    });
  }

  rows.sort((a, b) => {
    if (a.approval.state === 'pending' && b.approval.state === 'pending') {
      // Least time remaining first. Ties broken by id so the order is stable
      // between identical reads — a queue that reshuffles looks broken.
      if (a.msToExpiry !== b.msToExpiry) return a.msToExpiry - b.msToExpiry;
      return a.approval.id.localeCompare(b.approval.id);
    }
    const aDecided = a.approval.decidedAt ?? a.approval.createdAt;
    const bDecided = b.approval.decidedAt ?? b.approval.createdAt;
    if (aDecided !== bDecided) return bDecided.localeCompare(aDecided);
    return a.approval.id.localeCompare(b.approval.id);
  });

  // One aggregate query rather than five paged fetches (M5-F, audit F-11).
  const counts: Record<string, number> = await deps.repos.approvals.countByState();

  return { status: 200, body: { approvals: rows, counts } };
}

/**
 * Runs the expiry sweep (spec §16).
 *
 * A callable command rather than a background worker, matching the rest of the
 * pipeline's explicit triggering (§14). Safe to call repeatedly: it only ever
 * touches `pending` rows that are past due.
 */
export async function handleExpireApprovals(
  deps: EmailHandlerDeps,
): Promise<HandlerResult<{ expired: number; skipped: number; emails: string[] }>> {
  const result = await sweepExpiredApprovals(deps);
  return {
    status: 200,
    body: {
      expired: result.expired.length,
      skipped: result.skipped,
      emails: result.expired.map((row) => row.subject),
    },
  };
}

export async function handleUnderstandEmail(
  deps: EmailHandlerDeps,
  id: string,
): Promise<HandlerResult<EmailDetail>> {
  const email = await deps.repos.emails.getById(id);
  if (!email) throw new NotFoundError('Email');

  // Re-running is allowed and appends a new analysis rather than replacing the
  // old one — history is never rewritten (spec §14). What is not allowed is
  // analysing an email mid-flight through another stage.
  assertUnderstandable(email);

  await understandEmail(email, deps);
  return handleGetEmail(deps, id);
}

/**
 * Runs UNDERSTAND over every email waiting for it. The "Process all" action
 * from the seeded inbox (§14) — still explicit, still no background worker.
 */
export async function handleUnderstandPending(
  deps: EmailHandlerDeps,
  input: unknown = {},
): Promise<HandlerResult<{ processed: number; failed: number; results: EmailSummary[] }>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  const limit = optionalInteger(body.limit, 'limit', problems, { min: 1, max: 100 });
  problems.throwIfAny();

  const pending = await deps.repos.emails.list({ state: 'received', limit: limit ?? 50 });

  let processed = 0;
  let failed = 0;
  const results: EmailSummary[] = [];

  for (const email of pending) {
    try {
      const outcome = await understandEmail(email, deps);
      processed++;
      results.push(toSummary(outcome.email, outcome.analysis));
    } catch (err) {
      // One email failing must not abandon the rest of the batch. The failure
      // is already recorded against that email by the stage itself.
      failed++;
      deps.logger?.error('Understanding an email threw', {
        emailId: email.id,
        internal: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: 200, body: { processed, failed, results } };
}

export { AppError, ValidationError };

/**
 * Creates a revision of a plan from a human's edits (M4-C).
 *
 * Deliberately NOT an approve-with-edits endpoint. It ends with a pending
 * approval on a new decision, which is then approved through the same endpoint
 * and executed by the same executor as any other plan. A combined endpoint
 * would be a second way into execution, and a second way into execution is
 * where a bypass grows.
 *
 * `editedBy` falls back to the operator identity the route already derives, so
 * an edit can never be anonymous.
 */
export async function handleRevise(
  deps: EmailHandlerDeps,
  decisionId: string,
  input: unknown,
  operator: string,
): Promise<HandlerResult<ReviseResponse>> {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);
  if (body.edits === undefined) problems.add('"edits" is required');
  const editedBy = body.editedBy === undefined
    ? operator
    : requireString(body.editedBy, 'editedBy', problems, { maxLength: 120 });
  problems.throwIfAny();

  const result = await reviseDecision(decisionId, { edits: body.edits, editedBy }, deps);
  const detail = await handleGetEmail(deps, result.decision.emailId);

  return {
    status: 201,
    body: {
      decision: result.decision,
      revision: result.revision,
      parentDecisionId: result.parentDecisionId,
      approval: result.approval,
      supersededApproval: result.supersededApproval,
      diff: result.diff,
      detail: detail.body,
    },
  };
}
