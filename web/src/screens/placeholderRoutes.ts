import type { RouteName } from '../router.ts';

// Which screens are still unbuilt, and what they will be.
//
// Plain TypeScript, not TSX, deliberately: Node's type stripping runs the test
// suite directly from source and cannot compile JSX, so anything a test needs to
// import lives in a `.ts` module. That is the same reason the revision, outbox
// and CRM presentation rules are modules rather than logic inside components.
//
// It was seven screens. M6-C built Deals, Contacts, Companies, Tasks and the
// audit log against the CRM the assistant actually writes to, so their entries
// are gone rather than reworded — a "coming soon" panel on a screen that now
// works is the same stale claim the milestone labels were.

export type PlaceholderRoute = Extract<RouteName, 'automation' | 'settings'>;

export type PlaceholderSpec = {
  summary: string;
  willShow: string[];
  /** Where this information can be seen today, if it can be. */
  availableToday?: string;
};

export const PLACEHOLDER_SCREENS: Record<PlaceholderRoute, PlaceholderSpec> = {
  automation: {
    summary: 'The rules, in plain language. Read-only in the first version, and honest about it.',
    availableToday:
      'The rules that fired for any one email — and the specific reason a human was needed — are shown on that email.',
    willShow: [
      'The action registry with each action’s risk tier and why it has that tier',
      'The confidence thresholds and what each band changes',
      'The autonomy level — and the fact that no level lets a tier-2 action run unattended',
    ],
  },
  settings: {
    summary: 'Adapter status and business profile — never secret values.',
    availableToday: 'Adapter status is reported by the health endpoint, which never returns key material.',
    willShow: [
      'Each adapter as configured or not configured, with no key material',
      'The business profile that shapes drafted replies',
      'The outbound-send switch, locked off, with the reason shown',
    ],
  },
};

export function isPlaceholderRoute(route: RouteName): route is PlaceholderRoute {
  return route === 'automation' || route === 'settings';
}
