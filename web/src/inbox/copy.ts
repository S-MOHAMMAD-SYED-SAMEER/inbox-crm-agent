import { formatTimeLeft, timeLeftMs, type GuestInfo } from '../auth/guest.ts';

// The small pieces of wording and formatting the Inbox, the email page, the approval queue and the audit log share.
//
// Pure, so each can be tested without a browser. Everything here exists because a screen said something that was
// misleading, ugly or wrong, and the fix belongs in one place rather than in five components.

/** What a paused email says where the pipeline would otherwise say "not matched yet" or "waiting for the email to be matched". */
export const PAUSED_FOR_PERSON = 'Paused — waiting for a person';

/** Whether an email is stopped because a person has to look at it, as opposed to simply not having reached a stage yet. */
export function isPaused(state: string): boolean {
  return state === 'needs_review';
}

/** The label on the Inbox's analyse button: it says how many emails it will read, because each one is a model request. */
export function analyseButtonLabel(waiting: number): string {
  return waiting === 1 ? 'Analyse waiting email (1)' : `Analyse waiting emails (${waiting})`;
}

/** The sentence under the button, so the cost is known before it is clicked. */
export function analyseCostNote(waiting: number): string | null {
  if (waiting === 0) return null;
  return `Reads ${waiting === 1 ? 'the 1 waiting email' : `all ${waiting} waiting emails`} in one go: ${waiting === 1 ? 'one model request' : `${waiting} model requests`} with a real model.`;
}

/** "1 action", "3 actions". */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A latency a person can read: "2.2 s", or "420 ms" under a second. Never a float with a dozen digits. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A due date or any moment shown to a person: a date and a time to the minute, never seconds. */
export function formatMoment(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A reason stored lower case (so it can follow "because") as a sentence: capital first letter. */
export function sentenceCase(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '' : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * Cuts text at a whole word and says so. The full text is always one click away (the caller offers it), so a cut is never the
 * end of what a person can read.
 */
export function cutAtWord(text: string, max: number): { shown: string; cut: boolean } {
  if (text.length <= max) return { shown: text, cut: false };
  const space = text.lastIndexOf(' ', max);
  const end = space > max * 0.5 ? space : max;
  return { shown: `${text.slice(0, end).trimEnd()}…`, cut: true };
}

export type CrmMatchLabel = 'Matched' | 'Needs a decision' | 'New record' | 'No match';

/**
 * What to call a resolution verdict. "New record" means one WILL be created; it was shown for every NO_MATCH, including the cold
 * pitch that is archived with no record at all. Once a plan exists, only a plan that creates the record may say so.
 */
export function crmMatchLabel(verdict: string, plannedToCreate: boolean | null): CrmMatchLabel {
  if (verdict === 'MATCH') return 'Matched';
  if (verdict === 'MATCH_CONFLICT') return 'Needs a decision';
  return plannedToCreate === false ? 'No match' : 'New record';
}

/**
 * The words for how a step ended. An approval that is waiting is "held for approval", not "blocked" or "stopped": it is working as
 * designed, and the old words read like a failure.
 */
export function outcomeFor(eventType: string, outcome: string): { label: string; tone: 'ok' | 'stopped' | 'failed' | 'held' } {
  if (outcome === 'blocked' && (eventType === 'approval_requested' || eventType === 'policy_evaluated')) {
    return { label: 'Held for approval', tone: 'held' };
  }
  if (outcome === 'ok') return { label: 'Done', tone: 'ok' };
  if (outcome === 'blocked') return { label: 'Stopped', tone: 'stopped' };
  if (outcome === 'failed') return { label: 'Failed', tone: 'failed' };
  if (outcome === 'skipped') return { label: 'Skipped', tone: 'ok' };
  return { label: outcome, tone: 'ok' };
}

/** What a person can do with an email that was handed to them. Mirrors the server's rule, which is the one that is enforced. */
export type ReviewAction = 'archive' | 'continue';

export function reviewActionsFor(state: string, reviewReason: string | null): ReviewAction[] {
  if (state !== 'needs_review') return [];
  return reviewReason === 'ambiguous_intent' ? ['archive', 'continue'] : ['archive'];
}

export const REVIEW_ACTION_LABELS: Readonly<Record<ReviewAction, { label: string; hint: string }>> = Object.freeze({
  archive: { label: 'Archive', hint: 'Drop this email. Nothing is created or changed in the CRM.' },
  continue: {
    label: 'Continue to CRM matching',
    hint: 'Records that a person checked this email, then matches and plans it as normal. The plan still needs approval.',
  },
});

/** Why "continue" is not offered, in the one case where a person might expect it. */
export function noContinueReason(reviewReason: string | null): string | null {
  return reviewReason === 'possible_injection'
    ? 'An email that may be trying to give the assistant instructions can only be archived.'
    : null;
}

/**
 * The marker next to a summary when the model's own text still names a value the checks discarded. The text is shown as the model
 * wrote it; this only says which text to distrust.
 */
export function mentionsDiscardedMarker(mentions: ReadonlyArray<{ claimedValue: string }> | undefined): string | null {
  if (!mentions || mentions.length === 0) return null;
  const values = mentions.map((mention) => `“${mention.claimedValue}”`).join(', ');
  return `Mentions a discarded value: ${values}`;
}

/** The pill beside a confidence number when code changed the category the number was given for. */
export function codeOverrideNote(modelCategory: string | null, confidence: number): string | null {
  if (modelCategory === null) return null;
  return `model ${confidence.toFixed(2)} for ${modelCategory.replace(/_/g, ' ')}`;
}

/** Whether a person can be asked to choose between records: the email stopped because more than one CRM record could be the right one. */
export function canChooseRecord(state: string, reviewReason: string | null): boolean {
  return state === 'needs_review' && reviewReason === 'match_conflict';
}

export const CHOOSE_THE_RECORD = 'Choose the record';
export const NONE_OF_THESE = 'None of these — create new records';

const stateWords = (state: string): string => state.replace(/_/g, ' ');

/**
 * What Continue did, said where the person is looking. It used to be replaced by the next message, so the one thing a person needed
 * to know ("matching found more than one record; choose one") was gone before they read it.
 */
export function continueResultMessage(state: string, reviewReason: string | null): string {
  if (state === 'awaiting_approval') return 'Continued. The email was matched and planned; the plan is waiting for approval.';
  if (canChooseRecord(state, reviewReason)) return 'Continued. CRM matching found more than one possible record; choose one.';
  if (state === 'needs_review') return 'Continued. It still needs a person.';
  return `Continued. It is now ${stateWords(state)}.`;
}

/** What a pick did. Picking never approves anything: when a plan was made, it is waiting for approval. */
export function pickResultMessage(state: string, reviewReason: string | null, createNew: boolean): string {
  const chosen = createNew ? 'Recorded: new records will be proposed.' : 'Record chosen.';
  if (state === 'awaiting_approval') return `${chosen} The plan is waiting for approval.`;
  if (canChooseRecord(state, reviewReason)) return `${chosen} The other kind of record still needs choosing.`;
  return `${chosen} It is now ${stateWords(state)}.`;
}

/** A span as the approval queue says it: "5m", "3h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * The time on an approval row. An owner's approval has its own 24-hour clock. A guest's sandbox lives two hours at most, so "23h 59m
 * left" would promise a day the demo does not have: a guest is told how long the demo itself has left, which is the truthful limit.
 */
export function approvalTimeLabel(msToExpiry: number, guest: GuestInfo | null, nowMs: number): string {
  if (guest) return `Demo ends in ${formatTimeLeft(Math.min(timeLeftMs(guest.expiresAt, nowMs), Math.max(0, msToExpiry)))}`;
  return msToExpiry < 0 ? `${formatDuration(msToExpiry)} overdue` : `${formatDuration(msToExpiry)} left`;
}

/** What approving did, in words: "Approved and carried out 1 action.", "... 3 actions.". */
export function approvedMessage(executed: number): string {
  return `Approved and carried out ${countLabel(executed, 'action')}.`;
}
