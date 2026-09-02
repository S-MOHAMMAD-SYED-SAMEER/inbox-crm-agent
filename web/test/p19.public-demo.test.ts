import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAuthenticated,
  isPublicDemo,
  publicDemoFromHealth,
  sessionFromResponse,
  type SessionState,
} from '../src/auth/session.ts';

// P19 — the front end's half of the public read-only demo.
//
// The server is what enforces this; nothing here is a control. What these tests
// defend is narrower and still worth defending: that the browser only enters
// demo mode when the server said so, that demo mode is never mistaken for being
// signed in, and that no mutating control is rendered while it is on.
//
// Tested the way the rest of this front end is tested — plain modules under
// Node's runner, plus source scanning for the structural rules that cannot be
// asserted without a DOM (NFR-9).

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** Source with comments stripped — several of these files discuss the very
 *  things they must not do, and a comment must not satisfy a check. */
const code = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// --- entering demo mode is the server's decision -----------------------------

test('demo mode is entered only when health says the window is open', () => {
  assert.equal(publicDemoFromHealth({ adapters: { demoPublicReadonly: true } }), true);
  assert.equal(publicDemoFromHealth({ adapters: { demoPublicReadonly: false } }), false);
});

test('anything the browser cannot read as an open window is treated as shut', () => {
  for (const body of [
    null,
    undefined,
    {},
    { adapters: null },
    { adapters: {} },
    { adapters: 'yes' },
    { adapters: { demoPublicReadonly: 'true' } },
    { adapters: { demoPublicReadonly: 1 } },
    { demoPublicReadonly: true },
    'ok',
    42,
  ]) {
    assert.equal(publicDemoFromHealth(body), false, `${JSON.stringify(body)} opened the demo`);
  }
});

// --- demo mode is not authentication ----------------------------------------

test('the demo state is never authenticated', () => {
  const demo: SessionState = { status: 'public-demo' };

  assert.equal(isAuthenticated(demo), false);
  assert.equal(isPublicDemo(demo), true);
});

test('the other states are not the demo state', () => {
  assert.equal(isPublicDemo({ status: 'loading' }), false);
  assert.equal(isPublicDemo({ status: 'anonymous' }), false);
  assert.equal(
    isPublicDemo({ status: 'authenticated', operator: 'operator', expiresAt: null }),
    false,
  );
});

test('a session body can never produce the demo state', () => {
  // The only way into `public-demo` is the health check. If a server response
  // to `/auth/session` could reach it, a hostile or confused body would be able
  // to put the app into a state the server never authorised.
  for (const body of [
    { authenticated: true, operator: 'operator' },
    { authenticated: false, operator: null },
    { status: 'public-demo' },
    { adapters: { demoPublicReadonly: true } },
    {},
    null,
  ]) {
    assert.notEqual(sessionFromResponse(body).status, 'public-demo');
  }
});

// --- the session flow asks the server, in the right order --------------------

test('demo mode is only ever considered after the session says anonymous', () => {
  const source = code('auth/useSession.ts');

  // The authenticated branch returns before the health check is reached, so a
  // signed-in operator never has their state decided by a public flag.
  const authenticatedReturn = source.indexOf("resolved.status === 'authenticated'");
  const healthCall = source.indexOf('api.health()');

  assert.ok(authenticatedReturn > -1, 'the authenticated short-circuit is gone');
  assert.ok(healthCall > -1, 'the health check is gone');
  assert.ok(authenticatedReturn < healthCall, 'health is consulted before the session is settled');
});

test('a failed health check falls back to the sign-in screen, not the demo', () => {
  const source = code('auth/useSession.ts');
  const afterHealth = source.slice(source.indexOf('api.health()'));

  assert.match(afterHealth, /catch\s*\{[\s\S]*?status:\s*'anonymous'/, 'health failure does not fail closed');
});

// --- no mutating control is rendered in demo mode ----------------------------

test('every screen that can mutate consults the demo flag', () => {
  for (const file of [
    'screens/Inbox.tsx',
    'screens/Approvals.tsx',
    'components/execution.tsx',
  ]) {
    assert.match(code(file), /usePublicDemo\(\)/, `${file} does not check for demo mode`);
  }
});

test('the pipeline controls, approvals and execution controls are all gated', () => {
  assert.match(code('screens/Inbox.tsx'), /publicDemo \? null : \(/, 'Inbox controls are not gated');
  assert.match(code('screens/Approvals.tsx'), /row\.actionable && !publicDemo/, 'approve/reject not gated');
  assert.match(code('components/execution.tsx'), /!publicDemo &&/, 'execution controls not gated');
  assert.match(
    code('components/execution.tsx'),
    /stage === 'failed' && !publicDemo/,
    'the retry control is not gated',
  );
});

test('the revise form cannot be reached in demo mode', () => {
  assert.match(
    code('screens/Approvals.tsx'),
    /editing === row\.approval\.id && rowDetail\?\.decision && !publicDemo/,
    'the revise form is not gated',
  );
});

test('the shell hides sign-out and states plainly that this is a demo', () => {
  const shell = read('components/AppShell.tsx');

  assert.match(code('components/AppShell.tsx'), /publicDemo \?/, 'the shell does not branch on demo mode');
  assert.match(shell, /Demo mode/i, 'there is no demo disclosure');
  assert.match(shell, /read-only/i, 'the disclosure does not say it is read-only');
  assert.match(shell, /synthetic/i, 'the disclosure does not say the data is invented');
});

test('the demo default is false everywhere it is read', () => {
  // A component rendered outside the provider must behave as it always did.
  assert.match(code('auth/publicDemo.tsx'), /createContext\(false\)/, 'the context defaults to true');
  assert.match(code('components/AppShell.tsx'), /publicDemo = false/, 'the shell prop defaults to true');
});

// --- the authenticated application is unchanged ------------------------------

test('an authenticated session still renders the application, not the demo', () => {
  const app = code('App.tsx');

  // The demo branch is a comparison against one status, so it cannot capture
  // the authenticated state — `publicDemo` is false whenever a session exists.
  assert.match(app, /const publicDemo = session\.state\.status === 'public-demo'/);

  // The shell is reached by both, and the operator still comes from the session.
  assert.match(app, /operator=\{session\.state\.status === 'authenticated' \? session\.state\.operator : ''\}/);

  // Login is still what an anonymous browser gets when the demo is shut.
  assert.match(app, /status === 'anonymous'[\s\S]{0,120}<Login/);
});

test('sign-out and the operator name are shown to a real operator only', () => {
  const shell = code('components/AppShell.tsx');

  // Both live in the non-demo half of the branch.
  const branch = shell.slice(shell.indexOf('publicDemo ?'));
  const elseHalf = branch.slice(branch.indexOf(') : ('));

  assert.match(elseHalf, /Signed in as/, 'the operator name is not in the authenticated branch');
  assert.match(elseHalf, /onSignOut/, 'sign-out is not in the authenticated branch');
});

test('mutation controls return when the demo flag is false', () => {
  // Each gate is a conjunction with `!publicDemo`, so the control reappears the
  // moment the flag is false — the demo removes controls, it does not delete
  // the feature.
  assert.match(code('screens/Inbox.tsx'), /\{publicDemo \? null : \(/);
  assert.match(code('screens/Approvals.tsx'), /row\.actionable && !publicDemo/);
  assert.match(code('components/execution.tsx'), /!publicDemo &&\s*\(stage === 'awaiting_approval'/);
});

test('no client file treats the demo flag as an authorisation decision', () => {
  // The flag hides controls. If it ever guards a fetch, the client has started
  // deciding what the server should allow, which is the mistake this whole
  // design avoids.
  for (const file of ['screens/Inbox.tsx', 'screens/Approvals.tsx', 'components/execution.tsx']) {
    const source = code(file);
    assert.doesNotMatch(
      source,
      /if\s*\(\s*publicDemo\s*\)\s*(return|throw)/,
      `${file} branches on the demo flag to refuse a request`,
    );
  }
});
