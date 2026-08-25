import type { ReactNode } from 'react';
import { ROUTES, routeToHash, type Route, type RouteName } from '../router.ts';

// The application shell: sidebar navigation, header, content slot.
//
// The navigation is the information architecture from spec §12, including its
// two deliberate departures from the brief's list — Approvals is top-level
// because human-in-the-loop is the product's core claim and a differentiator
// hidden inside a filter is invisible; Leads is a saved view on Deals rather
// than a section, because a lead is a deal in an early stage and giving it its
// own section would duplicate records under two names, which is the exact CRM
// hygiene problem this product claims to fix.

type NavItem = {
  route: RouteName;
  label: string;
  hint: string;
  group: 'work' | 'crm' | 'system';
};

const NAV: NavItem[] = [
  { route: 'overview', label: 'Overview', hint: 'System status', group: 'work' },
  { route: 'inbox', label: 'Inbox', hint: 'Every processed email', group: 'work' },
  { route: 'approvals', label: 'Approvals', hint: 'Pending human decisions', group: 'work' },
  { route: 'contacts', label: 'Contacts', hint: 'People', group: 'crm' },
  { route: 'companies', label: 'Companies', hint: 'Organisations', group: 'crm' },
  { route: 'deals', label: 'Deals', hint: 'Pipeline', group: 'crm' },
  { route: 'tasks', label: 'Tasks', hint: 'Follow-ups', group: 'crm' },
  { route: 'automation', label: 'Automation', hint: 'Rules, risk tiers, thresholds', group: 'system' },
  { route: 'audit', label: 'Audit log', hint: 'Every automated decision', group: 'system' },
  { route: 'settings', label: 'Settings', hint: 'Adapters and configuration', group: 'system' },
];

const GROUP_LABELS: Record<NavItem['group'], string> = {
  work: 'Work',
  crm: 'CRM',
  system: 'System',
};

type AppShellProps = {
  route: Route;
  children: ReactNode;
  /**
   * The signed-in operator, as reported by the server's session endpoint.
   *
   * Displayed only because it came from `GET /api/auth/session`. It is never
   * typed in, never taken from a header, and never stored in this browser —
   * the header that used to carry an operator name was removed in M5-A
   * precisely because anyone could set it.
   */
  operator: string;
  onSignOut(): void;
  /** A recoverable problem worth telling the operator about. */
  notice: string | null;
  onDismissNotice(): void;
};

export function AppShell({
  route,
  children,
  operator,
  onSignOut,
  notice,
  onDismissNotice,
}: AppShellProps): ReactNode {
  const current = NAV.find((item) => item.route === route.name);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface focus:px-4 focus:py-2 focus:shadow-hover"
      >
        Skip to content
      </a>

      <div className="mx-auto flex max-w-[1400px] flex-col md:flex-row">
        <nav aria-label="Sections" className="shrink-0 border-line md:min-h-screen md:w-60 md:border-r">
          <div className="px-5 py-6">
            <p className="text-eyebrow uppercase text-ink-muted">AI Business Automation</p>
            <p className="mt-1 text-subhead">Inbox-to-CRM Agent</p>
          </div>

          {(['work', 'crm', 'system'] as const).map((group) => (
            <div key={group} className="px-3 pb-4">
              <p className="px-2 pb-1 text-eyebrow uppercase text-ink-muted">{GROUP_LABELS[group]}</p>
              <ul>
                {NAV.filter((item) => item.group === group).map((item) => {
                  const active = item.route === route.name;
                  return (
                    <li key={item.route}>
                      <a
                        href={routeToHash({ name: item.route, id: null })}
                        aria-current={active ? 'page' : undefined}
                        className={[
                          'block rounded-control px-2 py-1.5 text-small transition-colors',
                          active
                            ? 'bg-brand-tint font-semibold text-brand'
                            : 'text-ink-muted hover:bg-surface hover:text-ink',
                        ].join(' ')}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <main id="main" className="min-w-0 flex-1 px-5 py-6 md:px-8 md:py-8">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-section">{current?.label ?? 'Overview'}</h1>
              {current ? <p className="mt-1 text-small text-ink-muted">{current.hint}</p> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-ink-muted">
                Signed in as <span className="font-semibold text-ink">{operator}</span>
              </span>
              <button
                type="button"
                onClick={onSignOut}
                className="h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Sign out
              </button>
            </div>
          </header>

          <div aria-live="polite">
            {notice ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-signal-tint p-3">
                <p className="text-small text-ink">{notice}</p>
                <button
                  type="button"
                  onClick={onDismissNotice}
                  className="h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}

export { ROUTES };
