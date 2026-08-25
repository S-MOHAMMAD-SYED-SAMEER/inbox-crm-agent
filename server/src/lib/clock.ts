// Time and identity, both injectable.
//
// Every timestamp and every id in this system comes from here rather than from
// `new Date()` / `randomUUID()` scattered through the code. Two reasons, and
// the second is the one that matters:
//
//   1. Determinism. A demo that must produce byte-identical output on every run
//      (NFR-1) cannot have timestamps drifting through it, and neither can a
//      test asserting an audit sequence.
//   2. Portability. Postgres would happily fill `DEFAULT now()` for us, but
//      SQLite's `now()` is spelled differently and returns a different format.
//      Generating both values in application code means the two drivers agree
//      by construction instead of by translation (§9).

export type Clock = {
  /** ISO-8601, UTC, millisecond precision. The only timestamp format in this system. */
  nowIso(): string;
};

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * A clock that starts at `startIso` and advances by `stepMs` on every call.
 * Advancing rather than freezing is deliberate: audit events within one run
 * must be orderable, and a frozen clock makes every event look simultaneous,
 * which would let a genuine ordering bug pass a test.
 */
export function createFixedClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let current = Date.parse(startIso);
  if (Number.isNaN(current)) throw new RangeError(`Invalid start time: ${startIso}`);
  return {
    nowIso() {
      const iso = new Date(current).toISOString();
      current += stepMs;
      return iso;
    },
  };
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
