import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { Overview } from './screens/Overview.tsx';
import { Inbox } from './screens/Inbox.tsx';
import { EmailDetail } from './screens/EmailDetail.tsx';
import { Approvals } from './screens/Approvals.tsx';
import { PlaceholderScreen } from './screens/placeholders.tsx';
import { isPlaceholderRoute } from './screens/placeholderRoutes.ts';
import { AuditLog, Companies, Contacts, Deals, Tasks } from './screens/Crm.tsx';
import { Login } from './screens/Login.tsx';
import { useSession } from './auth/useSession.ts';
import { DEFAULT_ROUTE, parseRoute, type Route } from './router.ts';

/**
 * Subscribes to the location hash.
 *
 * Deliberately a hook here rather than a context: exactly one component needs
 * the current route, and threading it through props from a single owner is
 * clearer than a provider nobody else consumes.
 */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? DEFAULT_ROUTE : parseRoute(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    // Re-read on mount too: the first render happens before this effect, and
    // the hash can already have changed by then (a deep link, or a reload).
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

export function App(): ReactNode {
  const route = useRoute();
  const session = useSession();

  // Three states, and the application is only one of them. Nothing below can be
  // reached by a browser the server has not confirmed a session for — and the
  // server refuses every protected endpoint anyway, so this gate is the honest
  // presentation of that boundary rather than the boundary itself (M5-A).
  if (session.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  if (session.state.status === 'anonymous') {
    return <Login onSignedIn={() => void session.refresh()} />;
  }

  return (
    <AppShell
      route={route}
      operator={session.state.operator}
      onSignOut={() => void session.signOut()}
      notice={session.notice}
      onDismissNotice={session.dismissNotice}
    >
      {route.name === 'overview' ? <Overview /> : null}
      {/* An id on the inbox route selects one email — the router already parses
          `#/inbox/<id>`, so the detail screen needs no route of its own. */}
      {route.name === 'inbox' ? (
        route.id ? <EmailDetail id={route.id} /> : <Inbox />
      ) : null}
      {route.name === 'approvals' ? <Approvals /> : null}

      {/* The CRM the assistant actually writes to (M6-C). Read-only. */}
      {route.name === 'deals' ? <Deals /> : null}
      {route.name === 'contacts' ? <Contacts /> : null}
      {route.name === 'companies' ? <Companies /> : null}
      {route.name === 'tasks' ? <Tasks /> : null}
      {route.name === 'audit' ? <AuditLog /> : null}

      {isPlaceholderRoute(route.name) ? <PlaceholderScreen route={route.name} /> : null}
    </AppShell>
  );
}
