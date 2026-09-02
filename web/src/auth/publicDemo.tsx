import { createContext, useContext, type ReactNode } from 'react';

// Whether this browser is looking at the public read-only demo (P19).
//
// WHY A CONTEXT, WHEN THE ROUTE DELIBERATELY IS NOT ONE
//
// `useRoute` is a hook because exactly one component needs the route. This is
// the opposite case: four unrelated components need the same answer — the
// approvals queue, the email detail, the inbox's process button, and the
// revise form nested inside the detail — and threading a boolean through
// `EmailDetail` into `reviseForm` purely to reach the last of them is the kind
// of prop that gets forgotten at one call site and silently defaults to false.
//
// WHAT THIS IS NOT
//
// It is not a permission check, and nothing may treat it as one. The server
// decides what a request without a session may do, and it refuses every
// mutation whether or not this value is correct. This exists so the interface
// does not offer a person a button that would fail — hiding a control the
// caller cannot use is honesty about the state of the system, not enforcement.
//
// Default false: a component rendered outside the provider behaves exactly as
// it did before this file existed, which is the safe direction for a value
// whose only job is to remove things.
//
// ORDER IN THIS FILE
//
// The hook is declared before the component deliberately. The hook-order guard
// in `m6e.polish.test.ts` reads a component's body as everything following its
// first `return`, so a hook defined after a component in the same file reads as
// a hook called after an early return. Putting the hook first keeps the source
// unambiguous for the reader and for that check.

const PublicDemoContext = createContext(false);

/** True when the product is being shown read-only, with nobody signed in. */
export function usePublicDemo(): boolean {
  return useContext(PublicDemoContext);
}

export function PublicDemoProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}): ReactNode {
  return <PublicDemoContext.Provider value={value}>{children}</PublicDemoContext.Provider>;
}
