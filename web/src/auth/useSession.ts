import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setCsrfFailureHandler, setUnauthorizedHandler } from '../api/client.ts';
import { guestStartError } from './guest.ts';
import { publicDemoFromHealth, sessionFromResponse, type SessionState } from './session.ts';

// The session gate.
//
// One hook owns the answer to "is anyone signed in?", and it gets that answer
// from the server every time — at startup, after a sign-in, after a sign-out,
// and whenever an API call comes back 401.
//
// WHY THERE IS NO LOCAL "isLoggedIn" FLAG TO SET
//
// A boolean the front end can set is a boolean that can disagree with the
// cookie, and the disagreement people notice is the one where the app shows a
// dashboard to somebody whose session ended twenty minutes ago. `refresh()`
// re-asks; nothing else can move the state to `authenticated`.
//
// AVOIDING THE LOOP
//
// The 401 handler sets state to `anonymous`. It does not re-fetch, so a dead
// session cannot start a check → 401 → check cycle. `/auth/session` itself
// answers 200 for anonymous and never 401s, which is what makes that safe.

export type Session = {
  state: SessionState;
  /** Whether the server offers the guest demo to a visitor. From the same answer that says nobody is signed in. */
  guestDemoEnabled: boolean;
  /** Starts a guest session. Resolves to an error message, or null on success. */
  startGuest(): Promise<string | null>;
  /** "Start over": the guest's sandbox returns to the seed. */
  startOver(): Promise<void>;
  /** Leaves the guest demo. */
  leaveGuest(): Promise<void>;
  /** Re-asks the server. The only way into an authenticated state. */
  refresh(): Promise<void>;
  signOut(): Promise<void>;
  /** Set when a request failed CSRF verification and the page should be reloaded. */
  notice: string | null;
  dismissNotice(): void;
};

export function useSession(): Session {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [guestDemoEnabled, setGuestDemoEnabled] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    let resolved: SessionState;
    try {
      const body = await api.session();
      setGuestDemoEnabled(body.guestDemoEnabled === true);
      resolved = sessionFromResponse(body);
    } catch {
      // Unreachable server, malformed answer — either way this browser cannot
      // be shown as signed in. Failing toward the sign-in screen is the only
      // safe direction.
      setState({ status: 'anonymous' });
      return;
    }

    if (resolved.status === 'authenticated') {
      setState(resolved);
      return;
    }

    // Nobody is signed in. Ask the server — not this browser — whether it is
    // serving a public demo. Only the server knows, and only the server
    // enforces it: if this check were ever wrong in the permissive direction,
    // the app would render and every request behind it would still 401.
    try {
      setState(publicDemoFromHealth(await api.health()) ? { status: 'public-demo' } : { status: 'anonymous' });
    } catch {
      setState({ status: 'anonymous' });
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // A logout that fails still ends the local session: the cookie is
      // HttpOnly and cannot be cleared from here anyway, so the honest move is
      // to stop showing the application and let the next request be refused.
    }
    setNotice(null);
    setState({ status: 'anonymous' });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setNotice(null);
      setState({ status: 'anonymous' });
    });

    setCsrfFailureHandler(() => {
      // The token and the session disagree — usually a sign-in in another tab.
      // Say something a person can act on, without describing the mechanism.
      setNotice('Your session changed in another tab. Reload the page and try that again.');
      void refresh();
    });

    return () => {
      setUnauthorizedHandler(null);
      setCsrfFailureHandler(null);
    };
  }, [refresh]);

  const startGuest = useCallback(async (): Promise<string | null> => {
    try {
      await api.startGuest();
      await refresh();
      return null;
    } catch (err) {
      return guestStartError(err instanceof ApiError ? err.status : 0, err instanceof ApiError ? err.message : null);
    }
  }, [refresh]);

  const startOver = useCallback(async (): Promise<void> => {
    try {
      await api.resetGuest();
      setNotice('The demo is back at the start.');
      // Every screen reads from the server, so a reload of the route is what shows the empty inbox.
      window.location.hash = '#/inbox';
      window.location.reload();
    } catch {
      setNotice('Could not start over. Reload the page and try again.');
    }
  }, []);

  const leaveGuest = useCallback(async (): Promise<void> => {
    try {
      await api.leaveGuest();
    } catch {
      // Leaving is idempotent on the server; whether or not it was reached, this browser is done with the demo.
    }
    setNotice(null);
    // Back to the sign-in page at the site's own address. The hash ("#/approvals") belongs to the screens of the demo that was just left;
    // keeping it would put a signed-out visitor at a deep link into a place they are no longer in.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
    setState({ status: 'anonymous' });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A guest's time left is drawn from the server's `expiresAt`. Asking for the session does not extend it, so this keeps the banner
  // honest after real activity without keeping an idle sandbox alive.
  const isGuest = state.status === 'authenticated' && state.role === 'guest';
  useEffect(() => {
    if (!isGuest) return undefined;
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [isGuest, refresh]);

  return {
    state,
    guestDemoEnabled,
    startGuest,
    startOver,
    leaveGuest,
    refresh,
    signOut,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
