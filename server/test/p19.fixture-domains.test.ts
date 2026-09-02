import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P19 — the demo data becomes public, so it must not name anybody real.
//
// WHY THIS IS A TEST AND NOT A ONE-OFF CLEANUP
//
// Before the demo was published, an invented address like `sarah@acme.io` was
// harmless: nobody outside the project ever saw it. Publishing changes that. A
// plausible domain in public fixture data is a message about a real company
// that does not know it is being used as an example, and the fix — a TLD that
// can never be registered — only holds if the next fixture added obeys it too.
//
// RFC 2606 reserves `.invalid`, `.test` and `.example`, and reserves
// `example.com`/`.net`/`.org` as second-level names. Anything else is a domain
// somebody can own.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = [
  'data/demo/emails.json',
  'data/demo/crm-seed.json',
  'eval/understand.dataset.json',
  'eval/resolve.dataset.json',
  'eval/decide.dataset.json',
];

/** Reserved by RFC 2606/6761, so guaranteed unregistrable. */
const RESERVED_TLDS = new Set(['invalid', 'test', 'example', 'localhost']);
const RESERVED_SLDS = new Set(['example.com', 'example.net', 'example.org']);

/**
 * Every host-looking token in a blob of JSON.
 *
 * Email local parts are stripped first: `j.contact@somewhere.invalid` contains
 * a dotted token before the `@` that is not a hostname, and treating it as one
 * reports a domain nobody wrote.
 */
function hostsIn(text: string): string[] {
  const withoutLocalParts = text.replace(/[A-Za-z0-9._%+-]+@/g, '@');
  return [...new Set(withoutLocalParts.match(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi) ?? [])].map((h) =>
    h.toLowerCase(),
  );
}

function isReserved(host: string): boolean {
  const parts = host.split('.');
  const tld = parts[parts.length - 1] ?? '';
  if (RESERVED_TLDS.has(tld)) return true;
  return RESERVED_SLDS.has(parts.slice(-2).join('.'));
}

test('no public fixture names a domain anybody could own', () => {
  const offenders: string[] = [];

  for (const relative of FIXTURES) {
    const full = path.join(SERVER_ROOT, relative);
    if (!fs.existsSync(full)) continue;

    const text = fs.readFileSync(full, 'utf8');
    for (const host of hostsIn(text)) {
      // Only judge things shaped like a public hostname. Version strings,
      // filenames and dotted identifiers are not addresses.
      if (!/\.[a-z]{2,}$/.test(host)) continue;
      if (/\.(?:json|ts|tsx|js|md|png|svg|sqlite)$/.test(host)) continue;
      if (isReserved(host)) continue;
      offenders.push(`${relative}: ${host}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `fixture data references registrable domains:\n  ${offenders.join('\n  ')}`,
  );
});

test('the demo emails still resolve their own evidence after the rename', () => {
  // The rename touched `bodyText`, `fromEmail` and every `sourceSpan` at once.
  // If it had touched only some, extraction would still pass its own schema and
  // quietly cite text that is no longer in the email — the exact failure the
  // product claims to make impossible.
  const emails = JSON.parse(
    fs.readFileSync(path.join(SERVER_ROOT, 'data/demo/emails.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;

  let checked = 0;

  for (const email of emails) {
    const haystack = [email.bodyText, email.subject, email.fromName, email.fromEmail, email.toEmail, email.cc]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');

    const understanding = email.mockUnderstanding as { extracted?: Record<string, unknown> } | undefined;
    for (const [field, value] of Object.entries(understanding?.extracted ?? {})) {
      const span = (value as { sourceSpan?: unknown }).sourceSpan;
      if (typeof span !== 'string') continue;
      checked += 1;
      assert.ok(
        haystack.includes(span),
        `${String(email.providerMessageId)} cites "${span}" for ${field}, which is not in the email`,
      );
    }
  }

  assert.ok(checked > 0, 'no spans were checked, so this proved nothing');
});
