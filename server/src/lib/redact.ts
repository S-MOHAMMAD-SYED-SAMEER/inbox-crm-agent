// PII redaction for logs (NFR-12).
//
// This system's inputs are other people's emails. That makes the log the most
// likely place for customer data to end up somewhere nobody intended — and a
// log file is the one artefact that gets copied into a terminal, a screenshot,
// or a support ticket without anyone thinking about it.
//
// The rule enforced by convention and by `logger.ts`: email bodies are never
// logged at all, and anything that *is* logged goes through here first.

const EMAIL_RE = /\b[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[a-z]{2,}\b/gi;
// Loose on purpose: catching a stray order number as a phone number is a
// harmless false positive in a log line; missing a real phone number is not.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;

/**
 * Masks an email address to `s***h@acmecommerce.io`.
 *
 * The domain survives deliberately — it is the part that makes a log line
 * useful for debugging ("the acmecommerce.io message failed"), and it is not
 * personal data in the way the local part is.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return `${'*'.repeat(local.length)}@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 5))}${local[local.length - 1]}@${domain}`;
}

// Internal record ids. Not personal data — we generate them — and genuinely
// useful in a log line, so they are protected from the phone-number rule.
// Without this, the digit runs inside a UUID look exactly like a phone number
// and get masked, which turns every id in the log into rubble and makes the
// logs useless for the debugging they exist for.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_PLACEHOLDER = '@@UUID@@';

export function redactText(text: string): string {
  // UUIDs are lifted out first and put back last, so no later rule can see
  // their digits. Order matters here and is the whole trick.
  const preserved: string[] = [];
  const withoutUuids = text.replace(UUID_RE, (match) => {
    preserved.push(match);
    return UUID_PLACEHOLDER;
  });

  const redacted = withoutUuids
    .replace(EMAIL_RE, (match) => maskEmail(match))
    .replace(PHONE_RE, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 7 ? `[phone:${digits.length}d]` : match;
    });

  let index = 0;
  return redacted.replace(new RegExp(UUID_PLACEHOLDER, 'g'), () => preserved[index++] ?? '');
}

// Keys whose values are never logged, whatever they contain. `bodyText` is here
// because an email body is the payload this whole product handles: there is no
// version of "just log a bit of it" that is safe.
const NEVER_LOG_KEYS = new Set([
  'bodytext',
  'body',
  'draftbody',
  'password',
  'apikey',
  'api_key',
  'authorization',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'databaseurl',
  'database_url',
]);

/**
 * Recursively redacts a value for logging: dropped keys are replaced with a
 * marker rather than removed, so a log line still shows that a field existed.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_LOG_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))) {
      out[key] = typeof item === 'string' ? `[redacted:${item.length}c]` : '[redacted]';
      continue;
    }
    out[key] = redactValue(item, depth + 1);
  }
  return out;
}
