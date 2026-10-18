import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { EmailSummary } from '../api/types.ts';
import { routeToHash } from '../router.ts';
import { reviewReasonLabel } from '../inbox/statePresentation.ts';
import { REVIEW_ACTION_LABELS, noContinueReason, reviewActionsFor, sentenceCase, type ReviewAction } from '../inbox/copy.ts';

// The emails the assistant handed to a person, listed where a person looks for work.
//
// They used to appear nowhere: the Approvals page counted only plans waiting for approval, so an ambiguous email, a suspected
// injection and a stopped conflict showed "Needs a person" in the Inbox and then led to a page whose only button was "Analyse
// again", which spends another model request. Each row here says why and offers what the server allows: archive always,
// continue only for an ambiguous reading.

export function NeedsPersonList({
  readOnly,
  onChanged,
}: {
  /** The read-only public view offers nothing to click. */
  readOnly: boolean;
  /** Called after an action so a count elsewhere on the page can refresh. */
  onChanged?: () => void;
}): ReactNode {
  const [emails, setEmails] = useState<EmailSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEmails((await api.listEmails('needs_review')).emails);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (email: EmailSummary, action: ReviewAction): Promise<void> => {
    setBusy(`${email.id}:${action}`);
    setNotice(null);
    try {
      const detail = await api.reviewEmail(email.id, action);
      setNotice(
        action === 'archive'
          ? `Archived “${email.subject}”. Nothing in the CRM changed.`
          : detail.email.state === 'awaiting_approval'
            ? `“${email.subject}” was checked, matched and planned. The plan is now waiting for approval.`
            : `“${email.subject}” was checked and continued. It is now ${detail.email.state.replace(/_/g, ' ')}.`,
      );
      await load();
      onChanged?.();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="rounded-card border border-line bg-danger-tint p-4">
        <p className="text-small font-semibold text-danger">Could not load these emails</p>
        <p className="mt-1 text-small text-ink-muted">{error}</p>
      </div>
    );
  }
  if (emails === null) return <p className="text-small text-ink-muted">Loading…</p>;

  return (
    <div className="space-y-3" data-needs-person-list>
      <div aria-live="polite">
        {notice ? <p className="rounded-control border border-line bg-surface p-3 text-small text-ink">{notice}</p> : null}
      </div>

      {emails.length === 0 ? (
        <div className="rounded-card border border-dashed border-line-strong bg-surface p-6">
          <p className="text-body">Nothing needs a person.</p>
          <p className="mt-1 text-small text-ink-muted">Emails the assistant could not safely act on on its own appear here.</p>
        </div>
      ) : null}

      {emails.map((email) => {
        const actions = reviewActionsFor(email.state, email.reviewReason);
        const why = noContinueReason(email.reviewReason);
        return (
          <section key={email.id} className="rounded-card border border-line bg-surface p-4 shadow-resting">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <a
                  href={routeToHash({ name: 'inbox', id: email.id })}
                  className="text-small font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {email.fromName ?? email.fromEmail}
                </a>
                <span className="text-small text-ink"> — {email.subject}</span>
              </div>
              <span className="rounded-pill border border-signal px-2 py-0.5 text-meta text-signal">Needs a person</span>
            </div>

            <p data-review-reason className="mt-2 text-small text-ink-muted">
              {email.reviewReason ? `${sentenceCase(reviewReasonLabel(email.reviewReason))}.` : 'The assistant handed it to a person.'}
            </p>
            {email.analysis ? <p className="mt-1 text-meta text-ink-muted">{email.analysis.summary}</p> : null}

            {readOnly ? null : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    disabled={busy !== null}
                    title={REVIEW_ACTION_LABELS[action].hint}
                    onClick={() => void act(email, action)}
                    className={`h-control rounded-control px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${
                      action === 'continue' ? 'bg-brand text-white' : 'border border-line-strong text-ink'
                    }`}
                  >
                    {busy === `${email.id}:${action}` ? 'Working…' : REVIEW_ACTION_LABELS[action].label}
                  </button>
                ))}
                <a
                  href={routeToHash({ name: 'inbox', id: email.id })}
                  className="text-meta text-brand underline-offset-2 hover:underline"
                >
                  Open the email
                </a>
              </div>
            )}
            {why ? <p className="mt-2 text-meta text-ink-muted">{why}</p> : null}
          </section>
        );
      })}
    </div>
  );
}
