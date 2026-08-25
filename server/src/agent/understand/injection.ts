import type { InjectionMatch, InjectionRecord, SanitisationRecord } from '../../domain/understanding.ts';

// Prompt-injection detection (spec §19, D6).
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
//
// This detector is a *signal*, not a defence. The defence is structural and
// lives elsewhere:
//
//   1. Email content is data, never instruction. It is delivered inside a
//      fenced block in a user turn, never concatenated into the system prompt,
//      and the fence is escaped so content cannot close it (understand/prompt.ts).
//   2. The model's only valid response is a call to `record_understanding`. It
//      has no tool that does anything, so there is no action for injected text
//      to trigger.
//   3. Authority is decided by code. `requiresApproval()` never reads model
//      output, and no autonomy level lets a consequential action run unattended
//      (agent/policy/approval.ts).
//
// Because of those three, **the system is safe even when this detector misses**.
// That is the property worth having: a detector you must not rely on is a
// detector that can be imperfect, and every regex-based detector is imperfect.
// What it adds is that a suspicious email is routed to a human and visibly
// labelled, rather than quietly processed and looking normal.
//
// It runs on the *sanitised* text, plus the sanitisation report, so a message
// that hid its payload in zero-width characters is caught by the fact that it
// contained them at all — the payload itself is already gone by then.

type Rule = {
  name: string;
  severity: 'high' | 'medium';
  pattern: RegExp;
  why: string;
};

const RULES: Rule[] = [
  {
    name: 'instruction_override',
    severity: 'high',
    pattern: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|prompts|rules?|directive)/i,
    why: 'Attempts to cancel the instructions the agent was given.',
  },
  {
    name: 'role_marker',
    severity: 'high',
    // A line that opens with a conversation role is trying to look like part of
    // the transcript rather than part of an email. No ordinary email does this.
    pattern: /^\s*(?:system|assistant|developer|\[system\]|<system>|###\s*system)\s*[:>]/im,
    why: 'Impersonates a system or assistant turn to look like part of the conversation.',
  },
  {
    name: 'new_instructions',
    severity: 'high',
    pattern: /\b(?:new|updated|revised)\s+(?:instructions?|system\s+prompt|directives?)\b|\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\b/i,
    why: 'Tries to install replacement instructions.',
  },
  {
    name: 'prompt_exfiltration',
    severity: 'high',
    pattern: /\b(?:reveal|repeat|print|show|output|display|tell\s+me)\b[^.\n]{0,40}\b(?:system\s+prompt|your\s+instructions|your\s+prompt|api\s+key|credentials?)\b/i,
    why: 'Tries to extract the system prompt or credentials.',
  },
  {
    name: 'autonomy_escalation',
    severity: 'high',
    pattern: /\b(?:without|skip|bypass|no\s+need\s+for)\b[^.\n]{0,30}\b(?:approval|review|confirmation|human)\b|\bauto(?:matically)?\s+(?:send|approve|reply)\b|\bsend\b[^.\n]{0,30}\bimmediately\s+without\b/i,
    why: 'Asks the agent to act without the human approval step.',
  },
  {
    name: 'concealment',
    severity: 'high',
    pattern: /\b(?:do\s+not|don't|never)\b[^.\n]{0,30}\b(?:tell|show|inform|mention\s+this\s+to)\b[^.\n]{0,20}\b(?:the\s+)?(?:user|human|operator|owner)\b/i,
    why: 'Asks the agent to hide something from the person operating it.',
  },
  {
    name: 'fenced_instruction_block',
    severity: 'medium',
    pattern: /<\/?\s*(?:system|instructions?|prompt)\s*>|\[\[\s*(?:system|instructions?)\s*\]\]/i,
    why: 'Contains markup shaped like an instruction fence.',
  },
  {
    name: 'encoded_payload',
    severity: 'medium',
    // A long unbroken base64-ish run in a business email is not a sentence.
    pattern: /\b[A-Za-z0-9+/]{200,}={0,2}\b/,
    why: 'Contains a long encoded blob, a common way to smuggle instructions past a reader.',
  },
];

/** Trimmed to keep an operator-facing banner readable and a log line bounded. */
const MAX_EVIDENCE = 160;

function evidenceFor(text: string, match: RegExpMatchArray): string {
  const found = match[0] ?? '';
  const start = Math.max(0, (match.index ?? 0) - 20);
  const window = text.slice(start, (match.index ?? 0) + found.length + 20).trim();
  return window.length > MAX_EVIDENCE ? `${window.slice(0, MAX_EVIDENCE)}…` : window;
}

export function detectInjection(
  text: string,
  options: { sanitisation?: SanitisationRecord; modelFlagged?: boolean } = {},
): InjectionRecord {
  const matches: InjectionMatch[] = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      matches.push({
        rule: rule.name,
        severity: rule.severity,
        evidence: evidenceFor(text, match),
        why: rule.why,
      });
    }
  }

  // Hidden characters are treated as a finding in their own right. There is no
  // legitimate reason for a business email to contain zero-width or
  // bidi-override characters, and their only practical use here is to show a
  // human one thing while showing the model another.
  const hidden = options.sanitisation?.removedHiddenCharacters ?? 0;
  if (hidden > 0) {
    matches.push({
      rule: 'hidden_characters',
      severity: 'medium',
      evidence: `${hidden} hidden character(s) removed during sanitisation`,
      why: 'Invisible characters can carry text a human reviewer cannot see but a model can.',
    });
  }

  const modelFlagged = options.modelFlagged === true;

  return {
    // The model's own suspicion counts, but cannot be the only thing that
    // counts: an email that successfully manipulates the model would also
    // convince it not to raise the flag. Either source is sufficient.
    suspected: matches.length > 0 || modelFlagged,
    matches,
    modelFlagged,
  };
}
