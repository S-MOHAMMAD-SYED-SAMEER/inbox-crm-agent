import { useEffect, useState, type ReactNode } from 'react';
import { bannerText, resetNote, type GuestInfo } from '../auth/guest.ts';

// The banner that is always on screen in the guest demo.
//
// It says what the visitor is looking at (a private copy, answers replayed from a recorded run, nothing sent), how long it lasts, and
// offers the two things a guest can do about it: start over, or leave.
//
// On a phone the full text would fill the first screen, so below 768px it is one line ("Guest demo · nothing is sent") with the whole
// sentence and the time left behind "Details". From 768px the whole sentence is on screen, as it always was. Start over asks first:
// it wipes everything, immediately, and used to do so on one click.

export const START_OVER_QUESTION = 'Start over? Your changes in this demo will be lost.';

const BUTTON =
  'h-control shrink-0 rounded-control border border-line-strong bg-surface px-3 text-meta font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50';

export function GuestBanner({
  info,
  busy,
  onStartOver,
  onLeave,
}: {
  info: GuestInfo;
  busy: boolean;
  onStartOver(): void;
  onLeave(): void;
}): ReactNode {
  // The countdown is drawn from the server's `expiresAt` and the clock here. It ticks without asking the server, so watching it does
  // not count as activity.
  const [now, setNow] = useState(() => Date.now());
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section
      role="status"
      aria-label="Guest demo"
      data-guest-banner
      className="sticky top-0 z-40 border-b border-signal bg-signal-tint px-4 py-2 md:px-5 md:py-3"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-semibold text-ink md:hidden">Guest demo · nothing is sent</p>
          <p className="hidden text-small font-semibold text-ink md:block">{bannerText(info)}</p>
          <p data-guest-time-left className="mt-0.5 hidden text-meta text-ink-muted md:block">
            {resetNote(info, now)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-guest-details
            aria-expanded={details}
            onClick={() => setDetails((open) => !open)}
            className={`${BUTTON} md:hidden`}
          >
            Details
          </button>
          <button type="button" data-guest-start-over disabled={busy || confirming} onClick={() => setConfirming(true)} className={BUTTON}>
            Start over
          </button>
          <button type="button" data-guest-leave aria-label="Leave the demo" disabled={busy} onClick={onLeave} className={BUTTON}>
            <span className="md:hidden">Leave</span>
            <span className="hidden md:inline">Leave the demo</span>
          </button>
        </div>
      </div>

      {details ? (
        <div data-guest-details-text className="mx-auto mt-2 max-w-[1400px] md:hidden">
          <p className="text-small text-ink">{bannerText(info)}</p>
          <p className="mt-0.5 text-meta text-ink-muted">{resetNote(info, now)}</p>
        </div>
      ) : null}

      {confirming ? (
        <div
          data-guest-confirm
          role="alertdialog"
          aria-label={START_OVER_QUESTION}
          className="mx-auto mt-2 flex max-w-[1400px] flex-wrap items-center gap-2"
        >
          <p className="text-small font-semibold text-ink">{START_OVER_QUESTION}</p>
          <button
            type="button"
            data-guest-confirm-yes
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onStartOver();
            }}
            className={BUTTON}
          >
            Yes, start over
          </button>
          <button type="button" data-guest-confirm-no onClick={() => setConfirming(false)} className={BUTTON}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}
