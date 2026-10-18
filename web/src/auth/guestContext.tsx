import { createContext, useContext, type ReactNode } from 'react';
import type { GuestInfo } from './guest.ts';

// Whether the person looking at the screen is a guest, and what the server said about their session.
//
// Presentation only, like `usePublicDemo`: it changes words (and disables owner-only controls so they read as unavailable). The
// server is what refuses a guest anything, and it refuses whether or not a screen got this right.

const GuestContext = createContext<GuestInfo | null>(null);

/** The guest's session, or null for the owner. */
export function useGuest(): GuestInfo | null {
  return useContext(GuestContext);
}

export function GuestProvider({ value, children }: { value: GuestInfo | null; children: ReactNode }): ReactNode {
  return <GuestContext.Provider value={value}>{children}</GuestContext.Provider>;
}
