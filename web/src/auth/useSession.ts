import { useCallback, useEffect, useState } from 'react';
import { api, setCsrfFailureHandler, setUnauthorizedHandler } from '../api/client.ts';
import { sessionFromResponse, type SessionState } from './session.ts';

// The session gate (M6-A).
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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(sessionFromResponse(await api.session()));
    } catch {
      // Unreachable server, malformed answer — either way this browser cannot
      // be shown as signed in. Failing toward the sign-in screen is the only
      // safe direction.
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    state,
    refresh,
    signOut,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
