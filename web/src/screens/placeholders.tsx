import type { ReactNode } from 'react';
import { MilestonePlaceholder } from '../components/MilestonePlaceholder.tsx';
import { PLACEHOLDER_SCREENS, type PlaceholderRoute } from './placeholderRoutes.ts';

// The two screens that are still not built. The list and the copy live in
// `placeholderRoutes.ts` so the tests can read them without compiling JSX.

export function PlaceholderScreen({ route }: { route: PlaceholderRoute }): ReactNode {
  const spec = PLACEHOLDER_SCREENS[route];
  return (
    <MilestonePlaceholder
      summary={spec.summary}
      willShow={spec.willShow}
      {...(spec.availableToday ? { availableToday: spec.availableToday } : {})}
    />
  );
}
