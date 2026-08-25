import type { DraftGuardrailViolation } from '../../domain/decision.ts';
import type { Understanding } from '../../domain/understanding.ts';

// Draft guardrails (spec §7's table).
//
// Deterministic post-checks on the model's prose, in the shape Project 1's
// `validateReply` established: a list of named policies, each returning either
// nothing or a violation with the offending text.
//
// WHY THESE ARE CODE AND NOT PROMPT INSTRUCTIONS
//
// The drafting prompt does tell the model not to quote a price. That is a
// request. These are the check. A model that ignores the instruction — because
// it is having a bad day, or because the email contained text designed to talk
// it into it — still cannot get a price past this file, and the operator sees
// exactly what it tried to say. Project 1 made the same split for the same
// reason, and it is the difference between hoping and knowing.
//
// A violation never deletes the draft. Spec §16: the plan is forced to require
// approval and the blocked text is shown, so the human can rewrite it.

export type GuardrailContext = {
  draftBody: string;
  draftSubject: string;
  /** The email, the understanding and the business profile — everything a draft may rely on. */
  groundingText: string;
  understanding: Understanding;
  senderEmail: string;
  businessName: string;
};

type Guardrail = {
  name: string;
  why: string;
  check(ctx: GuardrailContext): string | null;
};

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const start = Math.max(0, (match.index ?? 0) - 30);
  const window = text.slice(start, (match.index ?? 0) + match[0].length + 30).trim();
  return window.length > 160 ? `${window.slice(0, 160)}…` : window;
}

/**
 * Digits that are structure rather than claims: list markers, and the numbers
 * inside a quoted line from the sender. Stripped before the grounding check so
 * "1." at the start of a line is not read as an invented figure.
 */
function stripStructuralDigits(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]?\s*\d+[.)]\s+/, ''))
    .join('\n')
    .replace(/^\s*>.*$/gm, '');
}

const GUARDRAILS: Guardrail[] = [
  {
    name: 'no_price_commitment',
    why: 'A price in an automated reply is a commitment the business has not agreed to.',
    check: (ctx) =>
      firstMatch(
        ctx.draftBody,
        /(?:[$£€₹]\s?\d|(?:\d[\d,.]*)\s?(?:usd|gbp|eur|inr|dollars?|pounds?|euros?)\b|\b(?:costs?|price|priced|quote|fee)\s+(?:is|would be|will be|starts? at|comes to)\b|\bper\s+(?:month|user|seat|hour)\b)/i,
      ),
  },
  {
    name: 'no_delivery_promise',
    why: 'A committed date or duration is a promise nobody has checked capacity for.',
    check: (ctx) =>
      firstMatch(
        ctx.draftBody,
        /\b(?:we(?:'| w)?ll|we will|we can|i can|i will)\b[^.\n]{0,40}\b(?:deliver|complete|finish|launch|have it (?:done|ready)|ship|turn(?:ed)? around)\b[^.\n]{0,30}\b(?:by|within|in)\b|\b(?:within|in)\s+\d+\s*(?:day|days|week|weeks|month|months)\b|\bready\s+(?:by|within)\b/i,
      ),
  },
  {
    name: 'no_discount_or_offer',
    why: 'A discount or free work is a concession only a person can make.',
    check: (ctx) =>
      firstMatch(
        ctx.draftBody,
        /\b(?:discount|discounted|free of charge|no charge|complimentary|waive[ds]?|on the house|at no cost|special (?:rate|price|offer))\b|\bfree\s+(?:trial|month|audit|work|consultation|setup)\b/i,
      ),
  },
  {
    name: 'no_legal_or_contractual_language',
    why: 'Guarantees and liability wording create obligations a draft must not create.',
    check: (ctx) =>
      firstMatch(
        ctx.draftBody,
        /\b(?:guarantee[ds]?|guaranteed|warrant(?:y|ies|ed)|liabilit(?:y|ies)|indemnif\w*|binding|terms and conditions|service level agreement|\bSLA\b|refund policy)\b/i,
      ),
  },
  {
    name: 'no_pii_echo',
    why: 'A reply should not repeat contact details the sender did not put in this email.',
    check: (ctx) => {
      const addresses = ctx.draftBody.match(/\b[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[a-z]{2,}\b/gi) ?? [];
      const allowed = new Set([ctx.senderEmail.toLowerCase()]);
      const grounding = ctx.groundingText.toLowerCase();

      for (const address of addresses) {
        const lowered = address.toLowerCase();
        // An address is fine if it is the sender's own or already appears in
        // the material the draft is allowed to draw on.
        if (allowed.has(lowered) || grounding.includes(lowered)) continue;
        return address;
      }
      return null;
    },
  },
  {
    name: 'no_invented_facts',
    why: 'Every specific figure in a reply must come from the email or the business profile.',
    check: (ctx) => {
      // The practical form of "no invented facts": a number the draft states
      // that appears nowhere in the email, the understanding, or the business
      // profile. This is what catches "we typically see a 300% increase" and
      // "our 24-hour response time" — the confident, checkable-sounding claims
      // that do the most damage precisely because they sound verified.
      const grounding = ctx.groundingText.replace(/[,\s]/g, '');
      const numbers = stripStructuralDigits(ctx.draftBody).match(/\d[\d,.]*/g) ?? [];

      for (const raw of numbers) {
        const normalised = raw.replace(/[,\s]/g, '').replace(/\.$/, '');
        if (normalised === '') continue;
        if (grounding.includes(normalised)) continue;
        return firstMatch(ctx.draftBody, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      return null;
    },
  },
];

export const GUARDRAIL_NAMES: readonly string[] = GUARDRAILS.map((guardrail) => guardrail.name);

export type GuardrailResult = {
  safe: boolean;
  passed: string[];
  violations: DraftGuardrailViolation[];
};

export function checkDraft(ctx: GuardrailContext): GuardrailResult {
  const passed: string[] = [];
  const violations: DraftGuardrailViolation[] = [];

  for (const guardrail of GUARDRAILS) {
    let evidence: string | null;
    try {
      evidence = guardrail.check(ctx);
    } catch (err) {
      // A guardrail that throws is treated as a violation, not a pass. Failing
      // safe applies to the checking code too — Project 1's rule, kept.
      evidence = `guardrail "${guardrail.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (evidence === null) passed.push(guardrail.name);
    else violations.push({ guardrail: guardrail.name, evidence, why: guardrail.why });
  }

  return { safe: violations.length === 0, passed, violations };
}

/**
 * Everything a draft is allowed to draw on.
 *
 * Deliberately assembled here rather than passed in piecemeal, so there is one
 * definition of "grounded" that both the prompt and the checker use.
 */
export function buildGroundingText(
  email: { subject: string; bodyText: string; fromEmail: string; fromName: string | null },
  understanding: Understanding,
  businessProfile: { name: string; services: string[]; tone: string },
): string {
  const extracted = Object.values(understanding.extracted)
    .map((field) => field.value)
    .filter((value): value is string => value !== null);

  return [
    email.subject,
    email.bodyText,
    email.fromEmail,
    email.fromName ?? '',
    understanding.intent,
    understanding.summary,
    understanding.questionAsked ?? '',
    ...extracted,
    businessProfile.name,
    ...businessProfile.services,
    businessProfile.tone,
  ].join('\n');
}
