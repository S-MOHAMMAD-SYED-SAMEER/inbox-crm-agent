import type { SanitisationRecord } from '../../domain/understanding.ts';

// Email sanitisation (FR-4, spec §19).
//
// Everything this system reads is attacker-controlled: anyone can send an
// email. Sanitisation happens once, at ingestion, and the sanitised text is
// what gets stored, displayed, and shown to the model. The original raw body
// is never persisted, so there is no path by which unsanitised content can be
// rendered later by some future screen that forgets to ask.
//
// THE THREE THINGS THIS REMOVES, AND WHY
//
//   * Scripts and event handlers. Obvious, but worth being explicit: nothing in
//     this product renders email HTML, so the safest handling is to never have
//     the markup at all.
//   * Remote images and other remote references. A tracking pixel tells the
//     sender the message was opened — by an automated system, at a predictable
//     time, which is exactly the reconnaissance a targeted attacker wants. It
//     is also an SSRF vector the moment anything server-side fetches it. Since
//     no remote resource is ever needed, none is ever kept.
//   * Hidden characters. Zero-width and bidirectional-override characters are
//     invisible to a human reviewing the email and fully visible to the model.
//     That gap is the whole trick: text a reviewer cannot see instructing a
//     model they can. Removing them collapses the gap, and the *count* is
//     reported so the injection detector can treat their presence as a signal
//     in its own right (see understand/injection.ts).
//
// This is deliberately not a general-purpose HTML sanitiser. It converts HTML
// to plain text and throws the rest away, which is a much smaller problem than
// "render untrusted HTML safely" — and it is smaller precisely because the
// product never needs to render it.

/** Spec §11: the body is capped before it reaches a model. */
export const MAX_BODY_LENGTH = 100_000;

export const TRUNCATION_MARKER = '\n\n[… truncated for analysis …]';

// Zero-width and directionality-control characters. Every one of these is
// invisible in a normal reading of the text.
const HIDDEN_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const REMOTE_REFERENCE = /<(?:link|iframe|object|embed|source|video|audio)\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;

const BLOCK_BREAK = /<\/?(?:p|div|br|tr|li|h[1-6]|blockquote|table)\b[^>]*>/gi;

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/gi, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match)
    .replace(/&#(\d{1,7});/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)));
}

function safeCodePoint(code: number): string {
  // A numeric entity is a second way to write any character, hidden ones
  // included — so decoding has to be able to produce them, and the hidden
  // character pass below has to run *after* decoding rather than before.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function looksLikeHtml(text: string): boolean {
  return /<(?:[a-z][a-z0-9]*)\b[^>]*>/i.test(text);
}

export type SanitiseResult = {
  text: string;
  record: SanitisationRecord;
};

export function sanitiseEmailBody(raw: string, options: { maxLength?: number } = {}): SanitiseResult {
  const maxLength = options.maxLength ?? MAX_BODY_LENGTH;
  const originalLength = raw.length;

  let text = raw;
  const isHtml = looksLikeHtml(text);

  const scripts = countMatches(text, SCRIPT_OR_STYLE);
  const images = countMatches(text, IMG_TAG);
  const remotes = countMatches(text, REMOTE_REFERENCE);

  if (isHtml) {
    text = text.replace(SCRIPT_OR_STYLE, ' ');
    text = text.replace(IMG_TAG, ' ');
    text = text.replace(REMOTE_REFERENCE, ' ');
    text = text.replace(BLOCK_BREAK, '\n');
    text = text.replace(ANY_TAG, ' ');
  }

  text = decodeEntities(text);

  // After decoding, so that a hidden character written as `&#8203;` is caught
  // as well as one written literally.
  const hidden = countMatches(text, HIDDEN_CHARACTERS);
  text = text.replace(HIDDEN_CHARACTERS, '');

  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Truncation is recorded, never silent: an operator has to be able to see
  // that the agent read part of a message rather than all of it.
  let truncated = false;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + TRUNCATION_MARKER;
    truncated = true;
  }

  return {
    text,
    record: {
      removedHtml: isHtml,
      removedScripts: scripts,
      removedRemoteImages: images + remotes,
      removedHiddenCharacters: hidden,
      truncated,
      originalLength,
      finalLength: text.length,
    },
  };
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(new RegExp(pattern.source, pattern.flags));
  return matches ? matches.length : 0;
}
