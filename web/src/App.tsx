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
import { PublicDemoProvider } from './auth/publicDemo.tsx';
import { GuestProvider } from './auth/guestContext.tsx';
import { showGuestButton } from './auth/guest.ts';
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
  // presentation of that boundary rather than the boundary itself.
  if (session.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  if (session.state.status === 'anonymous') {
    // The guest demo is offered to a visitor and to nobody else: this screen is only shown when nobody is signed in, so an owner who
    // is signed in never sees the button, and the server would refuse the request if they somehow made it.
    const offerDemo = showGuestButton(session.state.status, session.guestDemoEnabled);
    return (
      <Login
        onSignedIn={() => void session.refresh()}
        guestDemoEnabled={offerDemo}
        onTryDemo={() => session.startGuest()}
      />
    );
  }

  // The public read-only demo. The same shell and the same screens, drawn
  // from the same endpoints — what differs is that there is no operator, no
  // sign-out, and no control that would attempt a change. This branch is not a
  // permission: the server has already decided, and it refuses every mutation
  // from here regardless of what this component renders.
  const publicDemo = session.state.status === 'public-demo';
  const guest = session.state.status === 'authenticated' && session.state.role === 'guest' ? (session.state.guest ?? null) : null;

  return (
    <PublicDemoProvider value={publicDemo}>
    <GuestProvider value={guest}>
    <AppShell
      route={route}
      operator={session.state.status === 'authenticated' ? session.state.operator : ''}
      onSignOut={() => void session.signOut()}
      notice={session.notice}
      onDismissNotice={session.dismissNotice}
      publicDemo={publicDemo}
      guest={guest}
      onStartOver={() => void session.startOver()}
      onLeaveGuest={() => void session.leaveGuest()}
    >
      {route.name === 'overview' ? <Overview /> : null}
      {/* An id on the inbox route selects one email — the router already parses
          `#/inbox/<id>`, so the detail screen needs no route of its own. */}
      {route.name === 'inbox' ? (
        route.id ? <EmailDetail id={route.id} /> : <Inbox />
      ) : null}
      {route.name === 'approvals' ? <Approvals /> : null}

      {/* The CRM the assistant actually writes to. Read-only. */}
      {route.name === 'deals' ? <Deals /> : null}
      {route.name === 'contacts' ? <Contacts /> : null}
      {route.name === 'companies' ? <Companies /> : null}
      {route.name === 'tasks' ? <Tasks /> : null}
      {route.name === 'audit' ? <AuditLog /> : null}

      {isPlaceholderRoute(route.name) ? <PlaceholderScreen route={route.name} /> : null}
    </AppShell>
    </GuestProvider>
    </PublicDemoProvider>
  );
}
