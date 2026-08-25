// A hash router in sixty lines (D4).
//
// The portfolio ships two pages with no router at all; a dashboard with ten
// screens needs one, but not a dependency's worth. What react-router adds over
// this is nested routes, loaders, and data APIs — none of which a screen switch
// requires. If deep-linking or nested layouts genuinely arrive later, swapping
// this file for react-router is a contained change, because everything else
// only ever imports `parseRoute` and `useRoute`.
//
// Hash routing rather than the History API because it needs no server-side
// rewrite rule: opening a URL directly works from `vite preview`, from a static
// host, and from a file:// path with no configuration anywhere.
//
// The parsing is a pure function, so it is unit-tested in `test/router.test.ts`
// with Node's test runner and no browser, no jsdom, and no test framework.

export const ROUTES = [
  'overview',
  'inbox',
  'approvals',
  'contacts',
  'companies',
  'deals',
  'tasks',
  'automation',
  'audit',
  'settings',
] as const;

export type RouteName = (typeof ROUTES)[number];

export type Route = {
  name: RouteName;
  /** The record id in `#/inbox/abc123`, when there is one. */
  id: string | null;
};

export const DEFAULT_ROUTE: Route = { name: 'overview', id: null };

function isRouteName(value: string): value is RouteName {
  return (ROUTES as readonly string[]).includes(value);
}

/**
 * Parses a location hash into a route.
 *
 * Anything unrecognised resolves to the default route rather than throwing or
 * rendering an error screen: a bad hash is almost always a stale link or a
 * typo, and dropping someone on the Overview is a better answer than a dead
 * end. A genuinely missing *record* is a different case, and that 404 belongs
 * to the screen that looked it up, not to the router.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);

  const [name, id] = segments;
  if (name === undefined || !isRouteName(name)) return DEFAULT_ROUTE;

  return { name, id: id ?? null };
}

export function routeToHash(route: Route): string {
  return route.id === null ? `#/${route.name}` : `#/${route.name}/${encodeURIComponent(route.id)}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeToHash(route);
}
