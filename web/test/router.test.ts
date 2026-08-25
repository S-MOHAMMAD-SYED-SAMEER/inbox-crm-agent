import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToHash, ROUTES, DEFAULT_ROUTE } from '../src/router.ts';

// Frontend logic that matters lives in plain modules, so it is tested with
// Node's own runner — no Vitest, no jsdom, no Testing Library (NFR-9). The
// router is pure string handling, which is exactly the kind of thing that
// breaks quietly on an edge case nobody tried by hand.

test('an empty or root hash resolves to the default route', () => {
  for (const hash of ['', '#', '#/', '#//']) {
    assert.deepEqual(parseRoute(hash), DEFAULT_ROUTE);
  }
});

test('every declared route parses', () => {
  for (const name of ROUTES) {
    assert.deepEqual(parseRoute(`#/${name}`), { name, id: null });
  }
});

test('a record id is parsed from the second segment', () => {
  assert.deepEqual(parseRoute('#/inbox/abc123'), { name: 'inbox', id: 'abc123' });
  assert.deepEqual(parseRoute('#/deals/9f3c'), { name: 'deals', id: '9f3c' });
});

test('an unknown route falls back to the default rather than erroring', () => {
  // A bad hash is nearly always a stale link or a typo. Dropping someone on
  // the Overview beats a dead end; a missing *record* is a different case and
  // belongs to the screen that looked it up.
  assert.deepEqual(parseRoute('#/not-a-real-screen'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('#/not-a-real-screen/with-an-id'), DEFAULT_ROUTE);
});

test('a query string is ignored', () => {
  assert.deepEqual(parseRoute('#/inbox?state=needs_review'), { name: 'inbox', id: null });
});

test('ids are decoded and re-encoded symmetrically', () => {
  const route = parseRoute('#/contacts/a%2Fb');
  assert.deepEqual(route, { name: 'contacts', id: 'a/b' });
  assert.equal(routeToHash(route), '#/contacts/a%2Fb');
  assert.deepEqual(parseRoute(routeToHash(route)), route);
});

test('round-tripping every route is stable', () => {
  for (const name of ROUTES) {
    const route = { name, id: null };
    assert.deepEqual(parseRoute(routeToHash(route)), route);
  }
});

test('a hash without the leading slash still parses', () => {
  assert.deepEqual(parseRoute('#inbox'), { name: 'inbox', id: null });
});
