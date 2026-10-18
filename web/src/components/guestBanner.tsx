import { useEffect, useState, type ReactNode } from 'react';
import { bannerText, resetNote, type GuestInfo } from '../auth/guest.ts';

// The banner that is always on screen in the guest demo.
//
// It says what the visitor is looking at (a private copy, answers replayed from a recorded run, nothing sent), how long it lasts, and
// offers the two things a guest can do about it: start over, or leave.

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
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section
      role="status"
      aria-label="Guest demo"
      data-guest-banner
      className="sticky top-0 z-40 border-b border-signal bg-signal-tint px-5 py-3"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-small font-semibold text-ink">{bannerText(info)}</p>
          <p data-guest-time-left className="mt-0.5 text-meta text-ink-muted">
            {resetNote(info, now)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-guest-start-over
            disabled={busy}
            onClick={onStartOver}
            className="h-control rounded-control border border-line-strong bg-surface px-3 text-meta font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
          >
            Start over
          </button>
          <button
            type="button"
            data-guest-leave
            disabled={busy}
            onClick={onLeave}
            className="h-control rounded-control border border-line-strong bg-surface px-3 text-meta font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
          >
            Leave the demo
          </button>
        </div>
      </div>
    </section>
  );
}
