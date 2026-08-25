import type { ReactNode } from 'react';

// A placeholder that tells the truth.
//
// Seven of the ten screens are not built. The choice was between omitting them
// from the navigation and showing them with invented data. Both are worse:
// omitting them hides the shape of the product, and fake data in a screenshot
// is the kind of thing that ends up in a client conversation as if it were real.
//
// WHY THIS NO LONGER NAMES A MILESTONE (M6-B)
//
// It used to say "Arrives in M5". M5 shipped — as authentication, rate limiting
// and outbound safety — and these screens did not come with it, so every one of
// them was making a claim that had quietly become false. A stale roadmap on
// screen is worse than no roadmap: a client reads it as a slipped promise, or
// worse, does not notice and believes it.
//
// So it says what is not built and where that information *is* available today,
// which is both true and useful — the CRM records these screens would list are
// visible on the email that created them, and every decision is on the audit
// trail attached to it.

export function MilestonePlaceholder({
  summary,
  willShow,
  availableToday,
}: {
  summary: string;
  willShow: string[];
  /** Where this information can be seen today, if it can be. */
  availableToday?: string;
}): ReactNode {
  return (
    <section className="rounded-card border border-dashed border-line-strong bg-surface p-6 shadow-resting">
      <p className="text-eyebrow uppercase text-signal">Not built yet</p>
      <p className="mt-2 text-body text-ink">{summary}</p>

      {availableToday ? (
        <p className="mt-3 rounded-control bg-canvas p-3 text-small text-ink-muted">{availableToday}</p>
      ) : null}

      <p className="mt-5 text-eyebrow uppercase text-ink-muted">When built, this screen will show</p>
      <ul className="mt-2 space-y-1">
        {willShow.map((item) => (
          <li key={item} className="text-small text-ink-muted">
            — {item}
          </li>
        ))}
      </ul>

      <p className="mt-5 text-meta text-ink-muted">
        Nothing on this screen is simulated. The foundation it will be built on — schema, repositories,
        adapters, and the approval policy — is in place and tested.
      </p>
    </section>
  );
}
