import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';

// The sign-in screen (M6-A).
//
// THERE IS NO USERNAME FIELD, AND THAT IS THE DESIGN.
//
// This build authenticates one operator against one password (M5-A decision 2).
// A username box would be a field the browser fills in and the server ignores —
// worse, it would look like the thing that establishes identity, when identity
// comes from the session the server issues. The operator name shown once signed
// in is read back from the server, never typed here.
//
// WHAT THIS COMPONENT DOES NOT DO
//
//   * store the password anywhere but the controlled input it is typed into,
//     which is cleared the moment submission succeeds or fails;
//   * write to localStorage, sessionStorage, or any other persistence;
//   * put anything in the URL;
//   * keep a "logged in" flag of its own — it reports success upward and the
//     app re-asks the server.
//
// A failed sign-in says one thing regardless of why, because the server answers
// the same way regardless of why (M5-A): distinguishing "wrong password" from
// "server has no password configured" would tell someone guessing which half of
// the problem to work on.

export function Login({ onSignedIn }: { onSignedIn(): void }): ReactNode {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (submitting || password === '') return;

    setSubmitting(true);
    setError(null);

    try {
      await api.login(password);
      // Cleared before anything else happens, so the value does not sit in a
      // component that might survive the transition.
      setPassword('');
      onSignedIn();
    } catch (err) {
      setPassword('');
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That did not match. Check the password and try again.'
          : 'Could not sign in. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <p className="text-eyebrow uppercase tracking-wide text-ink-muted">AI Business Automation</p>
          <h1 className="mt-1 text-section text-ink">Inbox-to-CRM Agent</h1>
          <p className="mt-2 text-small text-ink-muted">
            The assistant prepares the work. A person stays in control of anything consequential.
          </p>
        </div>

        <form
          className="rounded-card border border-line bg-surface p-5 shadow-resting"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="operator-password" className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
            Operator password
          </label>
          <input
            id="operator-password"
            type="password"
            value={password}
            autoComplete="current-password"
            autoFocus
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'signin-error' : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-control border border-line bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          />

          <div aria-live="polite">
            {error ? (
              <p id="signin-error" className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-small text-danger">
                {error}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={submitting || password === ''}
            className="mt-4 h-control w-full rounded-control bg-brand px-4 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-meta text-ink-muted">
          The password is checked on the server and never stored in this browser.
        </p>
      </div>
    </main>
  );
}
