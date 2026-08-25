import { requiresApproval } from '../policy/approval.ts';
import { ACTION_TYPES } from '../../domain/actions.ts';
import {
  idempotencyKey,
  planFingerprint,
  type ExecutionOutcome,
  type ExecutionRecord,
  type OutboxRecord,
  type RefusalCode,
} from '../../domain/execution.ts';
import { allocateRefs, applyAction, assertEveryActionExecutable, hasExecutor } from '../../adapters/crm/localWriter.ts';
import { createOutboundSender, type OutboundSender } from '../../adapters/outbound/index.ts';
import { isRetryable, type OutboundResult } from '../../domain/outbound.ts';
import { runToResolution } from '../resolve/resolve.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import type { DecisionRecord } from '../../domain/decision.ts';
import type { EmailRecord } from '../../domain/email.ts';
import type { AppConfig } from '../../config/env.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { newId as defaultNewId, type IdGenerator } from '../../lib/ids.ts';
import { createLogger, type Logger } from '../../lib/logger.ts';
import { AppError } from '../../lib/errors.ts';

// STAGE 3 — EXECUTE, part one: the verification boundary (FR-25, FR-27..FR-33).
//
// THE UI IS NOT THE SECURITY BOUNDARY. THIS FILE IS.
//
// Everything below re-derives its facts from the database. It does not trust:
//
//   * the frontend — a button can be wrong, or absent, or forged
//   * the request body — no caller may assert "this was approved" or "tier 0"
//   * the stored plan's own `requiresApproval` — that is a cached answer, so the
//     policy is re-run from the analysis, the resolution and current settings
//   * model output — it never reached the plan in the first place (M3), and it
//     certainly does not reach here
//
// A refusal names the specific check that said no. "Something went wrong" would
// make an approval bypass and a typo look the same from the outside.

export type ExecuteDeps = {
  repos: Repositories;
  config?: AppConfig;
  clock?: Clock;
  newId?: IdGenerator;
  logger?: Logger;
  /**
   * How an approved reply is delivered (M4-D).
   *
   * Defaults to whatever the server configuration allows, which by default is
   * a sender that refuses everything. Injectable so a test can supply a mock —
   * never so a request can.
   */
  sender?: OutboundSender;
};

type Refusal = { code: RefusalCode; message: string };

function refuse(code: RefusalCode, message: string): Refusal {
  return { code, message };
}

/**
 * Every check that must pass before anything is written.
 *
 * Ordered cheapest-first, but the order carries no security meaning: all of
 * them must pass, and any one of them refusing is final.
 */
export async function verifyExecutable(
  email: EmailRecord,
  decision: DecisionRecord,
  repos: Repositories,
  now: string,
): Promise<Refusal | null> {
  // 1. The decision is still the current one. A re-decide supersedes, and an
  //    approval on a superseded plan authorises nothing.
  if (decision.supersededBy !== null) {
    return refuse('decision_superseded', 'This plan was replaced by a newer one and can no longer be run.');
  }

  // 2. The email is in a state that permits execution. `execution_failed` is
  //    included because retrying a failed attempt is precisely what the retry
  //    path is for; `completed` and `archived` are not, so a finished email
  //    cannot be run a second time.
  if (!['awaiting_approval', 'deciding', 'execution_failed'].includes(email.state)) {
    return refuse('invalid_state', `This email cannot be executed while it is ${email.state.replace(/_/g, ' ')}.`);
  }

  // 3. Every action is in the closed registry and has an executor. An action
  //    with no executor fails closed rather than being skipped quietly.
  for (const action of decision.plan.actions) {
    if (!(ACTION_TYPES as readonly string[]).includes(action.type)) {
      return refuse('unknown_action_type', `"${action.type}" is not an action this system can perform.`);
    }
    if (!hasExecutor(action.type)) {
      return refuse('no_executor_for_action', `"${action.type}" has no implementation yet, so nothing was run.`);
    }
  }

  // 4. A blocked draft can never be sent. Checked before any mutation, so a
  //    plan containing an unsafe reply does not half-apply.
  const sendsEmail = decision.plan.actions.some((action) => action.type === 'send_email');
  if (sendsEmail) {
    if (decision.plan.draft === null) {
      return refuse('draft_blocked', 'This plan sends a reply but no reply was written.');
    }
    if (decision.plan.draft.blockedBy.length > 0) {
      return refuse(
        'draft_blocked',
        `The reply was blocked by ${decision.plan.draft.blockedBy.map((v) => v.guardrail).join(', ')} and must be rewritten before it can be queued.`,
      );
    }
  }

  // 5. Re-run the approval policy from stored facts rather than reading the
  //    plan's cached flag. This is the check that makes a tampered
  //    `requires_approval` column irrelevant.
  const analysis = await repos.analyses.getLatestForEmail(email.id);
  const contact = runToResolution('contact', await repos.entityMatches.getLatestRun(email.id, 'contact'));
  const company = runToResolution('company', await repos.entityMatches.getLatestRun(email.id, 'company'));
  const settings = await repos.settings.getAll();

  const policy = requiresApproval({
    actions: decision.plan.actions,
    autonomyLevel: settings.autonomy_level,
    ...(analysis ? { confidenceBand: analysis.understanding.confidenceBand, flags: analysis.understanding.flags } : {}),
    hasMatchConflict: contact.verdict === 'MATCH_CONFLICT' || company.verdict === 'MATCH_CONFLICT',
    draftGuardrailViolations: decision.plan.draft?.blockedBy.map((v) => v.guardrail) ?? [],
    adapterSupportsAtomicity: true,
  });

  // The stored flag is a FLOOR, never a permission (M4-C).
  //
  // M4-A's rule stands unchanged: a plan claiming `requires_approval = false`
  // gets no say, because `policy.required` is recomputed above and is consulted
  // first. What this adds is the other direction — a plan that needed a human
  // when it was made still needs one now, even if the recomputation has since
  // gone soft because somebody loosened the autonomy setting.
  //
  // Without it, the revision engine's floor would be decorative: a revision can
  // record `requiresApproval: true` all it likes, and the executor would run it
  // unapproved anyway. Tampering is still not a route in, since this can only
  // ever add a requirement.
  if (policy.required || decision.plan.requiresApproval) {
    const approval = await repos.approvals.getForDecision(decision.id);

    if (!approval) {
      return refuse('approval_missing', 'This plan needs approval and no one has approved it.');
    }
    if (approval.decisionId !== decision.id) {
      // Belt and braces: the lookup is by decision id, so this cannot normally
      // differ. It is asserted anyway because "the approval belongs to this
      // plan" is the property, not "a query returned a row".
      return refuse('approval_wrong_decision', 'That approval belongs to a different plan.');
    }
    if (approval.state !== 'approved') {
      return refuse(
        'approval_not_granted',
        approval.state === 'rejected'
          ? 'This plan was rejected and cannot be run.'
          : `This plan is ${approval.state} and has not been approved.`,
      );
    }
    if (approval.expiresAt <= now) {
      return refuse('approval_expired', 'That approval has expired. A person needs to look at this again.');
    }
    if (approval.planHash !== null && approval.planHash !== planFingerprint(decision.plan)) {
      return refuse(
        'plan_changed_since_approval',
        'The plan changed after it was approved, so the approval no longer covers it.',
      );
    }
  }

  return null;
}

/**
 * Applies an approved plan.
 *
 * ATOMICITY: every CRM mutation happens inside one transaction, applied through
 * repositories bound to that transaction so the guarantee holds on both drivers
 * and not merely on the one whose connection happens to be shared. On any
 * failure the transaction rolls back, so the CRM is untouched, and the failure
 * rows are written afterwards in their own transaction — otherwise the record
 * of the failure would roll back along with it.
 *
 * IDEMPOTENCY: each action carries a content-derived key with a UNIQUE
 * constraint behind it. An action that already succeeded is skipped, so running
 * this twice produces one set of records, not two.
 */
export async function executePlan(
  email: EmailRecord,
  decision: DecisionRecord,
  {
    repos,
    clock = systemClock,
    newId = defaultNewId,
    logger = createLogger('execute'),
    sender = createOutboundSender(),
  }: ExecuteDeps,
): Promise<ExecutionOutcome> {
  assertEveryActionExecutable();

  const now = clock.nowIso();
  const refusal = await verifyExecutable(email, decision, repos, now);

  if (refusal) {
    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'execute',
      eventType: 'action_failed',
      actor: 'system',
      outcome: 'blocked',
      summary: `Execution refused: ${refusal.message}`,
      payload: { refusedWith: refusal.code, decisionId: decision.id },
      entityType: 'decision',
      entityId: decision.id,
    });

    logger.warn('Execution refused', { emailId: email.id, refusedWith: refusal.code });
    return { ok: false, refusedWith: refusal.code, refusalMessage: refusal.message, executions: [], outbox: null };
  }

  // --- what has already run --------------------------------------------------

  const attempt = (await repos.executions.lastAttempt(decision.id)) + 1;
  const planned = decision.plan.actions.map((action, index) => ({
    action,
    sequence: index + 1,
    key: idempotencyKey(decision.id, index + 1, action.type, action.payload),
  }));

  const alreadyDone = new Map<string, ExecutionRecord>();
  for (const item of planned) {
    const existing = await repos.executions.findByIdempotencyKey(item.key);
    if (existing && existing.status === 'succeeded') alreadyDone.set(item.key, existing);
  }

  const todo = planned.filter((item) => !alreadyDone.has(item.key));
  if (todo.length === 0) {
    logger.info('Nothing to execute; every action already succeeded', { emailId: email.id });
    // Delivery is still attempted: the CRM work being done says nothing about
    // whether the reply got out, and a send that failed on an earlier attempt
    // is exactly what a retry is for. `deliverIfNeeded` is idempotent — a
    // message already `sent` or `suppressed` is left alone.
    return {
      ok: true,
      refusedWith: null,
      refusalMessage: null,
      executions: [...alreadyDone.values()],
      outbox: await deliverIfNeeded(),
    };
  }

  await repos.emails.setState(email.id, 'executing');
  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'execute',
    eventType: 'state_changed',
    actor: 'system',
    outcome: 'ok',
    summary: `Applying ${todo.length} action(s).`,
    payload: { state: 'executing', decisionId: decision.id, attempt },
  });

  // --- apply, atomically -----------------------------------------------------

  const refs = allocateRefs(todo.map((item) => item.action), newId);
  const applied: Array<{ item: (typeof planned)[number]; result: Awaited<ReturnType<typeof applyAction>> }> = [];
  let failure: { item: (typeof planned)[number]; error: Error } | null = null;

  try {
    // `repos.transaction`, NOT `repos.db.transaction`. The difference is
    // invisible on SQLite and decisive on Postgres: repositories close over the
    // database handle they were built with, so writes made through the outer
    // `repos` inside a `repos.db.transaction` block go out on a *different*
    // pooled client and commit independently of it. A mid-plan failure would
    // then roll back nothing, and FR-28's "all actions or none" would hold on
    // the driver we test against and quietly not hold on the one we deploy to.
    //
    // Binding the repositories to `tx` removes the difference between the two
    // drivers rather than relying on one of them being forgiving.
    await repos.transaction(async (tx) => {
      for (const item of todo) {
        const result = await applyAction(item.action, {
          repos: tx,
          refs,
          emailId: email.id,
          source: 'agent',
        });
        applied.push({ item, result });
      }
    });
  } catch (err) {
    // The transaction rolled back: the CRM is exactly as it was. Which action
    // threw is recoverable because `applied` records how far it got.
    const error = err instanceof Error ? err : new Error(String(err));
    const failedItem = todo[applied.length] ?? todo[todo.length - 1];
    failure = failedItem ? { item: failedItem, error } : null;
    applied.length = 0;
  }

  // --- record what happened --------------------------------------------------

  if (failure) {
    const record = await repos.executions.record({
      decisionId: decision.id,
      sequence: failure.item.sequence,
      actionType: failure.item.action.type,
      payload: failure.item.action.payload,
      status: 'failed',
      // A retry re-derives the same key, so a failed attempt does not consume
      // the idempotency slot the eventual success needs.
      idempotencyKey: `${failure.item.key}:attempt-${attempt}`,
      errorCode: (failure.error as AppError).code ?? 'INTERNAL_ERROR',
      errorMessage: failure.error.message,
      attempt,
      startedAt: now,
    });

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'execute',
      eventType: 'action_failed',
      actor: 'system',
      outcome: 'failed',
      summary: `${failure.item.action.type.replace(/_/g, ' ')} failed: ${failure.error.message} Nothing was changed.`,
      payload: { actionType: failure.item.action.type, attempt, decisionId: decision.id },
      entityType: 'decision',
      entityId: decision.id,
    });

    await repos.emails.setState(email.id, 'execution_failed', { reviewReason: 'execution_failed' });
    logger.error('Execution failed and rolled back', {
      emailId: email.id,
      action: failure.item.action.type,
      internal: failure.error.message,
    });

    return {
      ok: false,
      refusedWith: null,
      refusalMessage: failure.error.message,
      executions: [record],
      outbox: null,
    };
  }

  const executions: ExecutionRecord[] = [...alreadyDone.values()];
  for (const { item, result } of applied) {
    executions.push(
      await repos.executions.record({
        decisionId: decision.id,
        sequence: item.sequence,
        actionType: item.action.type,
        payload: item.action.payload,
        status: 'succeeded',
        idempotencyKey: item.key,
        targetType: result.targetType,
        targetId: result.targetId,
        beforeSnapshot: result.before,
        afterSnapshot: result.after,
        attempt,
        startedAt: now,
      }),
    );

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'crm_write',
      eventType: result.before === null ? 'crm_record_created' : 'crm_record_updated',
      actor: 'system',
      outcome: 'ok',
      summary: `${item.action.type.replace(/_/g, ' ')} applied.`,
      payload: { actionType: item.action.type, targetType: result.targetType },
      ...(result.targetType && result.targetId
        ? { entityType: result.targetType, entityId: result.targetId }
        : {}),
    });
  }

  // --- the outbox boundary, and delivery -------------------------------------
  //
  // The outbox is the durable boundary (§15, FR-32). A reply is written here,
  // in full and inspectable, BEFORE anything tries to deliver it — so "what
  // would have gone out?" is answerable even when nothing did, and the outbox
  // status is the single answer to "did this actually go?".
  //
  // Nothing above this point consulted the send configuration, and nothing
  // inside it re-decides whether the plan was allowed to run. Approval, the
  // plan fingerprint, the draft guardrails and the decision's currency were all
  // settled by `verifyExecutable`. Delivery is the last step, not a second
  // gate — and a sender that is disabled simply refuses, which is why the
  // default configuration cannot reach a provider at all.
  //
  // It is a function because it has TWO callers. A plan whose CRM actions have
  // all already succeeded returns early below, and a delivery that failed on a
  // previous attempt has to be retryable from there — otherwise a single
  // provider outage would strand an approved reply as `failed` for ever, with
  // no way back short of re-deciding the whole plan.
  async function deliverIfNeeded(): Promise<OutboxRecord | null> {
    let outbox: OutboxRecord | null = null;
    const sendAction = decision.plan.actions.find((action) => action.type === 'send_email');

    if (sendAction && decision.plan.draft !== null) {
      const recipient = (sendAction.payload as { toEmail?: string } | undefined)?.toEmail ?? email.fromEmail;
      const existing = await repos.outbox.findForDecision(decision.id);

      // Already delivered or already refused by configuration: do nothing. This
      // is what makes a repeated execution produce one message rather than two,
      // and it is checked against the stored row rather than against a flag in
      // memory.
      if (existing?.status === 'sent' || existing?.status === 'suppressed') {
        outbox = existing;
      } else {
        outbox =
          existing ??
          (await repos.outbox.create({
            emailId: email.id,
            decisionId: decision.id,
            toEmail: recipient,
            subject: decision.plan.draft.subject,
            body: decision.plan.draft.body,
            status: sender.enabled ? 'queued' : 'suppressed',
            suppressedReason: sender.enabled ? null : 'outbound_send_disabled',
          }));

        if (!sender.enabled) {
          await repos.audit.append({
            correlationId: email.correlationId,
            emailId: email.id,
            stage: 'outbox',
            eventType: 'outbox_suppressed',
            actor: 'system',
            outcome: 'blocked',
            summary: 'The approved reply was placed in the outbox and NOT sent — outbound sending is disabled.',
            payload: { decisionId: decision.id, status: 'suppressed', reason: 'outbound_send_disabled' },
            entityType: 'decision',
            entityId: decision.id,
          });
        } else {
          // The recipient must be the one in the approved plan. The outbox row was
          // written from that plan, so this compares the message about to be sent
          // against the plan a human read — not against anything a request said.
          if (outbox.toEmail !== recipient) {
            await repos.outbox.markFailed(outbox.id, 'recipient_mismatch');
            await repos.audit.append({
              correlationId: email.correlationId,
              emailId: email.id,
              stage: 'outbox',
              eventType: 'outbound_send_blocked',
              actor: 'system',
              outcome: 'blocked',
              summary: 'The reply was not sent: its recipient did not match the approved plan.',
              payload: { decisionId: decision.id, reason: 'recipient_mismatch' },
              entityType: 'decision',
              entityId: decision.id,
            });
            outbox = await repos.outbox.findForDecision(decision.id);
          } else {
            // THE CLAIM (M5-D, audit F-05).
            //
            // One conditional UPDATE decides who delivers. Only `queued` or
            // `failed` can become `sending`, so of two concurrent executors
            // exactly one proceeds — and the provider is never called before
            // this succeeds. Losing the race is not an error: the other attempt
            // holds the message, and this one simply stops.
            const claimed = await repos.outbox.claimForSending(outbox.id);
            if (!claimed) {
              logger.info('Another attempt already holds this reply; not sending.', {
                emailId: email.id,
                decisionId: decision.id,
              });
              return await repos.outbox.findForDecision(decision.id);
            }
            outbox = claimed;

            const sendKey = idempotencyKey(decision.id, planned.length, 'send_email', sendAction.payload);

            await repos.audit.append({
              correlationId: email.correlationId,
              emailId: email.id,
              stage: 'outbox',
              eventType: 'outbound_send_attempted',
              actor: 'system',
              outcome: 'ok',
              // Recipient and provider, never the subject or the body: §19 keeps
              // message content out of the audit log, and a reply quotes the
              // customer's own email.
              summary: `Claimed the approved reply and is delivering it via the ${sender.name} provider.`,
              payload: {
                decisionId: decision.id,
                provider: sender.name,
                toEmail: recipient,
                outboxId: outbox.id,
              },
              entityType: 'decision',
              entityId: decision.id,
            });

            let result: OutboundResult;
            try {
              result = await sender.send(
                {
                  toEmail: recipient,
                  subject: decision.plan.draft.subject,
                  body: decision.plan.draft.body,
                  inReplyToProviderMessageId:
                    (sendAction.payload as { inReplyToProviderMessageId?: string | null } | undefined)
                      ?.inReplyToProviderMessageId ?? null,
                },
                { emailId: email.id, decisionId: decision.id, idempotencyKey: sendKey },
              );
            } catch (err) {
              // A provider that throws is a provider that failed. It is never a
              // provider that sent.
              result = {
                ok: false,
                kind: 'unavailable',
                message: err instanceof Error ? err.message : String(err),
              };
            }

            if (result.ok) {
              outbox = (await repos.outbox.markSent(outbox.id, result.providerMessageId)) ?? outbox;
              await repos.audit.append({
                correlationId: email.correlationId,
                emailId: email.id,
                stage: 'outbox',
                eventType: 'outbound_send_succeeded',
                actor: 'system',
                outcome: 'ok',
                summary: `The approved reply was delivered to ${recipient}.`,
                payload: {
                  decisionId: decision.id,
                  provider: sender.name,
                  providerMessageId: result.providerMessageId,
                },
                entityType: 'decision',
                entityId: decision.id,
              });
            } else {
              // A failed send never becomes `sent`, and it does not fail the
              // execution: the CRM work is done and correct, and a reply that did
              // not go out is a thing for a person to look at rather than a reason
              // to roll back five records. There is no automatic retry — §18's
              // rule is to fail toward the human, and a silent retry loop is the
              // opposite of that.
              outbox = (await repos.outbox.markFailed(outbox.id, result.kind)) ?? outbox;
              await repos.audit.append({
                correlationId: email.correlationId,
                emailId: email.id,
                stage: 'outbox',
                eventType: 'outbound_send_failed',
                actor: 'system',
                outcome: 'failed',
                summary:
                  `The approved reply could not be delivered (${result.kind}). ` +
                  (isRetryable(result.kind) ? 'It can be retried.' : 'Retrying will not help.'),
                payload: {
                  decisionId: decision.id,
                  provider: sender.name,
                  kind: result.kind,
                  retryable: isRetryable(result.kind),
                },
                entityType: 'decision',
                entityId: decision.id,
              });

              logger.error('Outbound delivery failed', {
                emailId: email.id,
                provider: sender.name,
                kind: result.kind,
                internal: result.message,
              });
            }
          }
        }
      }
    }
    return outbox;
  }

  const outbox = await deliverIfNeeded();

  // --- final state -----------------------------------------------------------

  const archives = decision.plan.actions.some((action) => action.type === 'archive_email');
  const finalState = archives ? 'archived' : 'completed';
  await repos.emails.setState(email.id, finalState);

  await repos.audit.append({
    correlationId: email.correlationId,
    emailId: email.id,
    stage: 'execute',
    eventType: 'action_executed',
    actor: 'system',
    outcome: 'ok',
    summary: `Applied ${applied.length} action(s) successfully.`,
    payload: { state: finalState, decisionId: decision.id, attempt, applied: applied.length },
    entityType: 'decision',
    entityId: decision.id,
  });

  logger.info('Execution complete', { emailId: email.id, applied: applied.length, state: finalState });
  return { ok: true, refusedWith: null, refusalMessage: null, executions, outbox };
}

/** Guards which states may enter execution, for callers that want to fail early. */
export function assertExecutable(email: EmailRecord): void {
  if (!['awaiting_approval', 'deciding', 'execution_failed'].includes(email.state)) {
    throw new AppError('INVALID_STATE', `This email cannot be executed while it is ${email.state.replace(/_/g, ' ')}.`);
  }
}
