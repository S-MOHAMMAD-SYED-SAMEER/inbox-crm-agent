import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { EmailDetail as EmailDetailPayload } from '../api/types.ts';
import { routeToHash } from '../router.ts';
import {
  CategoryChip,
  ConfidenceBadge,
  EmailBody,
  PriorityChip,
  StateChip,
} from '../components/understanding.tsx';
import { ResolutionCard } from '../components/resolution.tsx';
import { describeDefence } from '../security/injectionPresentation.ts';
import { DecisionCard } from '../components/decision.tsx';
import { ExecutionCard } from '../components/execution.tsx';

// The email detail screen — M1 scope.
//
// It shows the original message beside stage ① UNDERSTAND, with the provenance
// interaction that makes the whole product credible: hover an extracted field
// and the exact text it came from lights up in the email. That is the
// difference between an operator being told a value was not invented and being
// shown it.
//
// Stages ② and ③ appear as what they actually are — not built yet, with the
// milestone named. Showing a plausible-looking decision here would be the one
// screenshot most likely to end up in a client conversation as if it were real.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; detail: EmailDetailPayload }
  | { status: 'error'; message: string };

const FIELD_LABELS: Record<string, string> = {
  contactName: 'Contact',
  contactEmail: 'Email',
  contactPhone: 'Phone',
  jobTitle: 'Job title',
  companyName: 'Company',
  companyDomain: 'Domain',
  serviceInterest: 'Service',
  requirementSummary: 'Requirement',
  budget: 'Budget',
  timeline: 'Timeline',
  urgencyCues: 'Urgency',
};

export function EmailDetail({ id }: { id: string }): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Above the early returns below, and it has to stay there. React counts hooks
  // per render: this used to sit further down, past `if (state.status ===
  // 'loading') return`, so the first render registered five hooks and the
  // second — once the fetch resolved — registered six. That is React error #310
  // ("Rendered more hooks than during the previous render"), and with no error
  // boundary anywhere it unmounted the tree and left a blank page. It meant
  // this screen had never once rendered successfully in a browser; only a
  // *failed* load survived, because the error branch returns before reaching
  // the sixth hook.
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', detail: await api.getEmail(id) });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <p className="text-small text-ink-muted">Loading…</p>;

  if (state.status === 'error') {
    return (
      <div className="rounded-card border border-line bg-danger-tint p-4">
        <p className="text-small font-semibold text-danger">Could not load this email</p>
        <p className="mt-1 text-small text-ink-muted">{state.message}</p>
        <a href={routeToHash({ name: 'inbox', id: null })} className="mt-3 inline-block text-small text-brand">
          ← Back to inbox
        </a>
      </div>
    );
  }

  const { email, analysis, resolution, decision, approval, executions, outbox, audit, stages } = state.detail;
  const understanding = analysis?.understanding;
  const highlight = hovered ? (understanding?.extracted[hovered]?.sourceSpan ?? null) : null;

  const runAction = async (action: () => Promise<{ refusalMessage?: string | null; detail?: EmailDetailPayload }>): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await action();
      if (result.detail) setState({ status: 'ready', detail: result.detail });
      else await load();
      setRefusal(result.refusalMessage ?? null);
    } catch (err) {
      setRefusal(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const chooseMatch = async (entityType: 'contact' | 'company', entityId: string | null): Promise<void> => {
    setBusy(true);
    try {
      setState({ status: 'ready', detail: await api.resolveMatch(id, entityType, entityId) });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  const reanalyse = async (): Promise<void> => {
    setBusy(true);
    try {
      setState({ status: 'ready', detail: await api.understandEmail(id) });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={routeToHash({ name: 'inbox', id: null })} className="text-small text-brand">
          ← Inbox
        </a>
        <button
          type="button"
          onClick={() => void reanalyse()}
          disabled={busy}
          className="h-control rounded-control border border-line-strong px-4 text-small font-semibold disabled:opacity-50"
        >
          {busy ? 'Analysing…' : analysis ? 'Analyse again' : 'Analyse'}
        </button>
      </div>

      <header className="rounded-card border border-line bg-surface p-5 shadow-resting">
        <h2 className="text-subhead">{email.subject}</h2>
        <p className="mt-1 text-small text-ink-muted">
          {email.fromName ? `${email.fromName} · ` : ''}
          {email.fromEmail} · {new Date(email.receivedAt).toLocaleString()}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StateChip state={email.state} reviewReason={email.reviewReason} />
          {understanding ? <CategoryChip category={understanding.category} /> : null}
          {understanding ? <PriorityChip priority={understanding.priority} /> : null}
          {understanding ? (
            <ConfidenceBadge band={understanding.confidenceBand} confidence={understanding.confidence} />
          ) : null}
        </div>
      </header>

      {analysis?.security.injection.suspected ? (
        <section className="rounded-card border border-danger bg-danger-tint p-5">
          <h3 className="text-small font-semibold text-danger">
            This email tries to give the agent instructions
          </h3>
          <p className="mt-1 text-small text-ink-muted">
            It was routed to a person and no action was taken. The email is treated as data: text inside it can
            never become an instruction, and nothing in this system can act on it without approval.
          </p>
          <ul className="mt-3 space-y-2">
            {analysis.security.injection.matches.map((match) => (
              // The rule's `why` is already a sentence a client can hear, so the
              // rule's internal name (`instruction_override`, `role_marker`) is
              // used as the key and never rendered. It named the finding twice,
              // once in English and once in database vocabulary.
              <li key={match.rule} className="text-meta">
                <span className="font-semibold text-danger">{match.why}</span>
                <p className="mt-0.5 text-ink-muted">Found in the email:</p>
                <p className="mt-0.5 rounded-control border border-line bg-surface p-2 font-mono text-ink">
                  {match.evidence}
                </p>
              </li>
            ))}
          </ul>
          {(() => {
            const defence = describeDefence(analysis.security.injection.modelFlagged);
            return (
              <div className="mt-3">
                <p className="text-meta font-semibold text-ink">{defence.headline}</p>
                <p className="mt-0.5 text-meta text-ink-muted">{defence.detail}</p>
              </div>
            );
          })()}
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
          <h3 className="text-eyebrow uppercase text-ink-muted">Original email</h3>
          {email.bodyTruncated ? (
            <p className="mt-2 rounded-control bg-signal-tint px-2 py-1 text-meta text-signal">
              This body was truncated for analysis.
            </p>
          ) : null}
          <div className="mt-3 rounded-control border border-line p-3">
            <EmailBody body={email.bodyText} highlight={highlight} />
          </div>
          <p className="mt-2 text-meta text-ink-muted">
            Hover an extracted field to highlight the text it came from.
          </p>
        </section>

        <div className="space-y-5">
          <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-eyebrow uppercase text-ink-muted">① Understand</h3>
              {analysis ? (
                <span className="text-meta text-ink-muted">
                  {analysis.model} · {analysis.promptVersion} · {analysis.latencyMs}ms
                  {analysis.attempt > 1 ? ` · attempt ${analysis.attempt}` : ''}
                </span>
              ) : null}
            </div>

            {!understanding ? (
              <p className="mt-3 text-small text-ink-muted">
                {stages.understand === 'failed'
                  ? 'The analysis provider could not be reached, so this email has not been read. It can be retried.'
                  : 'Not analysed yet.'}
              </p>
            ) : (
              <>
                <dl className="mt-3 space-y-2">
                  <div>
                    <dt className="text-meta uppercase text-ink-muted">Intent</dt>
                    <dd className="text-small">{understanding.intent}</dd>
                  </div>
                  <div>
                    <dt className="text-meta uppercase text-ink-muted">Why this priority</dt>
                    <dd className="text-small">{understanding.priorityReason}</dd>
                  </div>
                  {understanding.questionAsked ? (
                    <div>
                      <dt className="text-meta uppercase text-ink-muted">Question asked</dt>
                      <dd className="text-small">{understanding.questionAsked}</dd>
                    </div>
                  ) : null}
                </dl>

                <h4 className="mt-4 text-eyebrow uppercase text-ink-muted">Extracted</h4>
                <ul className="mt-2 divide-y divide-line">
                  {Object.entries(understanding.extracted).map(([field, value]) => (
                    <li
                      key={field}
                      onMouseEnter={() => setHovered(value.value ? field : null)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(value.value ? field : null)}
                      onBlur={() => setHovered(null)}
                      tabIndex={value.value ? 0 : -1}
                      className={`flex items-baseline justify-between gap-3 py-1.5 text-small ${
                        value.value ? 'cursor-default rounded-control hover:bg-brand-tint' : ''
                      }`}
                    >
                      <span className="text-ink-muted">{FIELD_LABELS[field] ?? field}</span>
                      {value.value ? (
                        <span className="text-right text-ink">{value.value}</span>
                      ) : (
                        <span className="text-right italic text-ink-muted">Not provided</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {analysis ? (
            <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
              <h3 className="text-eyebrow uppercase text-ink-muted">Validation</h3>
              <p className="mt-2 text-small text-ink-muted">
                What deterministic code did to the agent&apos;s answer before any of it was stored.
              </p>

              {analysis.validation.droppedFields.length === 0 &&
              analysis.validation.coherenceAdjustments.length === 0 &&
              analysis.validation.normalisations.length === 0 ? (
                <p className="mt-3 text-small">
                  Every value the agent proposed was supported by the email. Nothing was discarded.
                </p>
              ) : null}

              {analysis.validation.droppedFields.map((dropped) => (
                <div key={dropped.field} className="mt-3 rounded-control border border-signal bg-signal-tint p-3">
                  <p className="text-small font-semibold text-signal">
                    Discarded {FIELD_LABELS[dropped.field] ?? dropped.field}: “{dropped.claimedValue}”
                  </p>
                  <p className="mt-1 text-meta text-ink-muted">{dropped.reason}.</p>
                </div>
              ))}

              {analysis.validation.coherenceAdjustments.map((adjustment) => (
                <div key={adjustment.what} className="mt-3 rounded-control border border-line p-3">
                  <p className="text-small">{adjustment.what}</p>
                  <p className="mt-1 text-meta text-ink-muted">{adjustment.why}.</p>
                </div>
              ))}
            </section>
          ) : null}

          <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
            <h3 className="text-eyebrow uppercase text-ink-muted">CRM match</h3>
            {resolution === null ? (
              <p className="mt-2 text-small text-ink-muted">
                {stages.understand === 'complete'
                  ? 'Not matched against the CRM yet.'
                  : 'Waiting for the email to be analysed first.'}
              </p>
            ) : (
              <>
                <p className="mt-2 text-meta text-ink-muted">
                  Matching is deterministic — the same email always produces the same candidates and scores. No
                  model is involved, and nothing has been written to the CRM.
                </p>
                <div className="mt-3 space-y-3">
                  <ResolutionCard
                    title="Contact"
                    resolution={resolution.contact}
                    busy={busy}
                    {...(stages.resolve === 'conflict'
                      ? { onChoose: (entityId: string | null) => void chooseMatch('contact', entityId) }
                      : {})}
                  />
                  <ResolutionCard
                    title="Company"
                    resolution={resolution.company}
                    busy={busy}
                    {...(stages.resolve === 'conflict'
                      ? { onChoose: (entityId: string | null) => void chooseMatch('company', entityId) }
                      : {})}
                  />
                </div>
              </>
            )}
          </section>

          {decision !== null ? (
            <DecisionCard decision={decision} />
          ) : (
            <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
              <h3 className="text-eyebrow uppercase text-ink-muted">② Decide</h3>
              <p className="mt-2 text-small text-ink-muted">
                {stages.resolve === 'complete'
                  ? 'No recommendation has been made for this email yet.'
                  : 'Waiting for the email to be matched against the CRM first.'}
              </p>
            </section>
          )}

          {decision !== null ? (
            <ExecutionCard
              approval={approval}
              executions={executions}
              outbox={outbox}
              stage={stages.execute}
              requiresApproval={decision.plan.requiresApproval}
              busy={busy}
              refusal={refusal}
              onApprove={() => void runAction(() => api.approve(decision.id))}
              onReject={(reason) => void runAction(async () => ({ detail: await api.reject(decision.id, reason) }))}
              onExecute={() => void runAction(() => api.execute(decision.id))}
            />
          ) : null}
        </div>
      </div>

      <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
        <h3 className="text-eyebrow uppercase text-ink-muted">Audit timeline</h3>
        <ol className="mt-3 space-y-2">
          {audit.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-small">
              <span className="font-mono text-meta text-ink-muted">
                {new Date(event.createdAt).toLocaleTimeString()}
              </span>
              <span
                className={`rounded-pill px-2 py-0.5 text-meta font-semibold ${
                  event.actor === 'ai'
                    ? 'bg-brand-tint text-brand'
                    : event.actor === 'human'
                      ? 'bg-success-tint text-success'
                      : 'bg-canvas text-ink-muted'
                }`}
              >
                {event.actor}
              </span>
              <span className="text-ink">{event.summary}</span>
              {event.outcome !== 'ok' ? (
                <span className="text-meta text-signal">({event.outcome})</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
