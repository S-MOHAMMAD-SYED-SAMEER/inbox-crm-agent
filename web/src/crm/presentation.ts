import type { RecordSource } from '../api/types.ts';

// How CRM records are described (M6-C).
//
// Pure, so it can be tested without a browser — the same reason the revision and
// outbox presentation live in modules rather than in JSX.
//
// THE SOURCE BADGE IS THE POINT OF THIS FILE
//
// Every CRM record carries `source`: `agent`, `human` or `seed`. Showing it is
// what lets a client see which rows the assistant produced — the whole claim of
// the product, made visible in the CRM rather than asserted in a slide.
//
// It must not overstate what that means. "Created by the assistant" is true.
// "AI-managed", "autonomous" or anything implying the record can change itself
// would not be: an agent-created row got there because a person approved a plan,
// and nothing the assistant does afterwards touches it without another approval.

export type SourcePresentation = {
  label: string;
  /** One line explaining what the badge actually means. */
  description: string;
  tone: 'agent' | 'human' | 'seed';
  /** A shape cue, so the badge never depends on colour alone. */
  marker: string;
};

const SOURCES: Readonly<Record<RecordSource, SourcePresentation>> = Object.freeze({
  agent: {
    label: 'From the assistant',
    description: 'Created by the assistant from an email, after a person approved the plan.',
    tone: 'agent',
    marker: '◆',
  },
  human: {
    label: 'Added by a person',
    description: 'Created directly by an operator.',
    tone: 'human',
    marker: '●',
  },
  seed: {
    label: 'Demo data',
    description: 'Part of the sample CRM this demo starts from.',
    tone: 'seed',
    marker: '○',
  },
});

export function presentSource(source: RecordSource): SourcePresentation {
  return SOURCES[source] ?? SOURCES.seed;
}

/** Deal stages as a person says them, not as the database stores them. */
const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  new_lead: 'New lead',
  qualifying: 'Qualifying',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
});

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ');
}

const TASK_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  open: 'Open',
  done: 'Done',
  cancelled: 'Cancelled',
});

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

/**
 * Money, from minor units.
 *
 * Amounts are stored in minor units because money is never a float. A deal with
 * no amount reads "Not set" rather than "0" — the agent deliberately does not
 * invent a number from an email, and a zero would look like one it had.
 */
export function formatAmount(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return 'Not set';

  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(major);
  } catch {
    // An unknown currency code must not blank the column.
    return `${major.toFixed(0)} ${currency}`;
  }
}

/** A date a person can read, or a dash. Never a raw ISO string. */
export function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Whether a task is past its due date. Overdue work should look overdue. */
export function isOverdue(dueAt: string | null, status: string, now: Date = new Date()): boolean {
  if (!dueAt || status !== 'open') return false;
  const parsed = Date.parse(dueAt);
  return !Number.isNaN(parsed) && parsed < now.getTime();
}

/** Audit event types in plain language. Unknown types degrade to readable text. */
const EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  email_received: 'Email received',
  content_sanitised: 'Content cleaned',
  classification_recorded: 'Email classified',
  extraction_recorded: 'Details extracted',
  field_dropped_no_provenance: 'Unsupported detail dropped',
  injection_suspected: 'Suspicious instructions detected',
  match_evaluated: 'CRM match considered',
  match_conflict_raised: 'CRM match conflict',
  match_resolved_by_human: 'Match chosen by a person',
  plan_created: 'Plan prepared',
  plan_revised: 'Plan edited by a person',
  draft_generated: 'Reply drafted',
  draft_blocked: 'Reply blocked by content checks',
  draft_edit_blocked: 'Edited reply blocked by content checks',
  policy_evaluated: 'Approval policy applied',
  approval_requested: 'Approval requested',
  approval_granted: 'Approved by a person',
  approval_rejected: 'Rejected by a person',
  approval_expired: 'Approval expired',
  approval_superseded: 'Approval replaced by a revision',
  action_executed: 'Actions carried out',
  action_failed: 'Action failed',
  crm_record_created: 'CRM record created',
  crm_record_updated: 'CRM record updated',
  outbox_queued: 'Reply queued',
  outbox_suppressed: 'Reply held — sending is off',
  outbound_send_attempted: 'Delivery attempted',
  outbound_send_succeeded: 'Reply delivered',
  outbound_send_failed: 'Delivery failed',
  outbound_send_blocked: 'Delivery blocked',
  human_reclassified: 'Reclassified by a person',
  state_changed: 'Status changed',
});

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, ' ');
}

export type ActorPresentation = { label: string; marker: string };

const ACTORS: Readonly<Record<string, ActorPresentation>> = Object.freeze({
  system: { label: 'System', marker: '⚙' },
  ai: { label: 'Assistant', marker: '◆' },
  human: { label: 'Person', marker: '●' },
});

export function actorLabel(actor: string): ActorPresentation {
  return ACTORS[actor] ?? { label: actor, marker: '·' };
}

const OUTCOMES: Readonly<Record<string, { label: string; tone: 'ok' | 'stopped' | 'failed' }>> = Object.freeze({
  ok: { label: 'Done', tone: 'ok' },
  blocked: { label: 'Stopped', tone: 'stopped' },
  failed: { label: 'Failed', tone: 'failed' },
  skipped: { label: 'Skipped', tone: 'ok' },
});

export function outcomeLabel(outcome: string): { label: string; tone: 'ok' | 'stopped' | 'failed' } {
  return OUTCOMES[outcome] ?? { label: outcome, tone: 'ok' };
}
