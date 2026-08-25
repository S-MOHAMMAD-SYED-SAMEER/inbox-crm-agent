// Row coercion — the second half of the two-driver asymmetry.
//
// The drivers do not return identical JavaScript for identical columns, and
// pretending otherwise is how a bug reaches production on one driver only:
//
//   BOOLEAN   sqlite → 0 / 1            postgres → true / false
//   BIGINT    sqlite → number           postgres → string  (js loses precision
//                                                           past 2^53, so `pg`
//                                                           refuses to guess)
//   NUMERIC   sqlite → number           postgres → string  (same reason)
//   TIMESTAMP sqlite → ISO text         postgres → Date object
//
// Every repository reads columns through these helpers rather than casting, so
// the difference is handled once, here, instead of in thirty places.

export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Expected a numeric column value, received ${String(value)}`);
  return parsed;
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return toNumber(value);
}

export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 't' || value === 'true' || value === '1';
  return false;
}

/**
 * Reads a JSON column. `JSONB` comes back already parsed from Postgres and as
 * text from SQLite, so both cases are handled rather than assuming either.
 *
 * A malformed value throws instead of returning `{}`: a JSON column that will
 * not parse means something wrote a value it should not have, and silently
 * swallowing that would hide the write bug behind an empty object.
 */
export function toJson<T = Record<string, unknown>>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a JSON column value, received ${typeof value}`);
  }
  return JSON.parse(value) as T;
}

/** Serialises a value for a JSON column. Both drivers accept text. */
export function fromJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
