// Audit vocabulary (spec §17, FR-38..FR-41).
//
// The audit trail is the answer to the first question a serious buyer asks
// about an AI touching their CRM: "what happens when it gets it wrong?" That
// makes it a product surface, not a debug log — so its vocabulary is a closed
// set checked against the database, exactly like every other domain enum.

export const AUDIT_STAGES = [
  'ingest',
  'understand',
  'resolve',
  'decide',
  'policy',
  'approval',
  'execute',
  'crm_write',
  'outbox',
  'system',
] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

// Who or what caused the event. Three actors, never more: the deterministic
// system, the model, or a person. An operator reading the log must be able to
// tell instantly which decisions were a machine's and which were a human's.
export const AUDIT_ACTORS = ['system', 'ai', 'human'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AUDIT_OUTCOMES = ['ok', 'blocked', 'failed', 'skipped'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

// Canonical event types (§17). Kept as a closed list so the Audit Log screen
// can render a known label per event and so a typo cannot quietly create a new
// event type nobody ever queries for.
export const AUDIT_EVENT_TYPES = [
  'email_received',
  'content_sanitised',
  'classification_recorded',
  'extraction_recorded',
  'field_dropped_no_provenance',
  'injection_suspected',
  'match_evaluated',
  'match_conflict_raised',
  'match_resolved_by_human',
  'plan_created',
  'draft_generated',
  'draft_blocked',
  // M4-C: a human editing a plan. `plan_revised` records the new decision,
  // `draft_edit_blocked` records an edit the guardrails refused — the second is
  // written even though no revision exists, because an attempt to put unsafe
  // text in front of a customer is exactly the thing an audit log is for.
  'plan_revised',
  'draft_edit_blocked',
  'policy_evaluated',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'approval_expired',
  'approval_superseded',
  'action_executed',
  'action_failed',
  'crm_record_created',
  'crm_record_updated',
  'outbox_queued',
  'outbox_suppressed',
  // M4-D. Every outbound attempt is traceable, and the four are distinct
  // situations: one was tried, one landed, one was refused by the provider,
  // one was refused by us before the provider was ever asked.
  'outbound_send_attempted',
  'outbound_send_succeeded',
  'outbound_send_failed',
  'outbound_send_blocked',
  'human_reclassified',
  'state_changed',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditEventInput = {
  correlationId: string;
  emailId?: string | null;
  stage: AuditStage;
  eventType: AuditEventType;
  actor: AuditActor;
  actorId?: string | null;
  outcome: AuditOutcome;
  /** One human-readable line. Required — an event nobody can read is not an audit trail. */
  summary: string;
  payload?: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  latencyMs?: number | null;
};

export type AuditEvent = {
  id: string;
  correlationId: string;
  emailId: string | null;
  sequence: number;
  stage: AuditStage;
  eventType: AuditEventType;
  actor: AuditActor;
  actorId: string | null;
  outcome: AuditOutcome;
  summary: string;
  payload: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  latencyMs: number | null;
  createdAt: string;
};
