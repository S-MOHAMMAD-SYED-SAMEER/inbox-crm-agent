// Normalisation and similarity for entity resolution.
//
// THE GOVERNING RISK IS OVER-NORMALISATION, NOT UNDER-NORMALISATION.
//
// A rule that fails to match two spellings of the same company costs a
// duplicate record, which a human notices and merges. A rule that matches two
// *different* companies writes one business's enquiry onto another business's
// record — and nobody notices, because the system looks like it worked. So
// every rule here is the narrowest one that does its job, and each is
// documented with what it deliberately does not do.
//
// Everything in this file is a pure function of its input. Entity matching must
// give the same answer on every run for the demo to be trustworthy, and a
// client asking "how did it know that was the same company?" deserves an answer
// more concrete than "the AI decided".

/**
 * Normalises an email address for comparison: trim, lowercase.
 *
 * Deliberately does NOT strip `+tag` suffixes or dots in the local part. Those
 * are Gmail conventions, not internet standards — at many providers
 * `first.last@` and `firstlast@` are genuinely different people, and treating
 * them as one would merge two colleagues into a single contact. Case folding is
 * safe because domains are case-insensitive by standard and no real mail system
 * distinguishes local parts by case.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Extracts and normalises the domain from an email address.
 *
 * Returns null for anything that is not a single well-formed address, so
 * callers handle "no domain" explicitly rather than receiving a guess.
 */
export function emailDomain(email: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(normaliseEmail(email));
  return match?.[1] ?? null;
}

/**
 * Normalises a domain: lowercase, trim, strip a protocol, a path, a port, and a
 * leading `www.`.
 *
 * Deliberately does NOT strip other subdomains. `mail.acme.com` and
 * `acme.com` may be the same organisation, but `uk.acme.com` and `us.acme.com`
 * are routinely different business units with different contacts, and there is
 * no way to tell which case you are in from the string alone. `www` is the one
 * exception because it never carries meaning.
 */
export function normaliseDomain(domain: string): string | null {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    ?.split('?')[0]
    ?.split(':')[0];

  if (!cleaned || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

// Titles and generational suffixes carry no identifying information, appear
// inconsistently, and are never the distinguishing part of a name.
const NAME_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'madam']);
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba']);

/**
 * Normalises a person's name: lowercase, strip diacritics, drop titles and
 * generational suffixes, remove punctuation, collapse whitespace.
 *
 * Deliberately does NOT reorder tokens. Sorting them would make "John Smith"
 * and "Smith John" identical, which is usually right and occasionally
 * catastrophic — plenty of real names are another name reversed. It also does
 * not expand or contract initials: "J Smith" stays distinct from "John Smith",
 * because collapsing them would merge every J. Smith at a company into one
 * person.
 */
export function normalisePersonName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);
  while (tokens.length > 1 && NAME_TITLES.has(tokens[0] as string)) tokens.shift();
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1] as string)) tokens.pop();

  return tokens.join(' ');
}

/**
 * Words that appear in so many company names that sharing one is no evidence at
 * all. Used only by the distinctive-token rule (see score.ts) — a shared
 * "digital" means nothing; a shared "harborview" means something.
 *
 * Kept deliberately generous: a word wrongly on this list costs a missed
 * candidate that surfaces as a new record, while a word wrongly *off* it can
 * link two unrelated businesses.
 */
export const GENERIC_NAME_TOKENS = new Set([
  'digital', 'media', 'studio', 'studios', 'consulting', 'consultants', 'solutions', 'services',
  'systems', 'partners', 'agency', 'labs', 'lab', 'tech', 'technology', 'technologies', 'global',
  'international', 'group', 'holdings', 'works', 'ventures', 'capital', 'associates', 'creative',
  'design', 'marketing', 'software', 'data', 'cloud', 'online', 'web', 'net', 'interactive',
  'commerce', 'retail', 'trading', 'enterprises', 'industries', 'the', 'and', 'of', 'for',
]);

/** The tokens of a normalised company name that actually identify it. */
export function distinctiveTokens(nameNorm: string): string[] {
  return nameNorm
    .split(' ')
    .filter(Boolean)
    .filter((token) => token.length >= 3 && !GENERIC_NAME_TOKENS.has(token));
}

/**
 * Trigram set for a string, using PostgreSQL's `pg_trgm` convention: split into
 * words, pad each with two leading spaces and one trailing space, take every
 * three-character window.
 *
 * Matching pg_trgm exactly is a deliberate choice rather than a coincidence.
 * At demo scale this runs in JavaScript over a handful of candidates; at real
 * scale the same comparison becomes a GIN-indexed `similarity()` query in
 * Postgres. Using the same definition now means that change is a query
 * rewrite, not a change in which records match.
 */
export function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Trigram similarity: |A ∩ B| / |A ∪ B| — the Jaccard index over trigram sets,
 * which is what `pg_trgm.similarity()` computes.
 *
 * Returns 0 rather than 1 for two empty strings: two things we know nothing
 * about are not evidence that they are the same thing.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection++;

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}
