// API types shared with the server.
//
// Hand-written and deliberately duplicated rather than imported across the
// server/web boundary. Importing server types into the browser bundle would
// drag server-only modules into the frontend's dependency graph, and the two
// halves deploy separately. The contract that matters is the JSON on the wire,
// and these types describe exactly that — nothing more.

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type Health = {
  status: 'ok' | 'degraded';
  database: {
    driver: string;
    reachable: boolean;
    migrationsApplied: number;
  };
  adapters: Record<string, string | boolean>;
  version: string;
};

export type EmailState =
  | 'received'
  | 'understanding'
  | 'understand_failed'
  | 'resolving'
  | 'deciding'
  | 'awaiting_approval'
  | 'needs_review'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'execution_failed'
  | 'expired'
  | 'archived';

export type ResolutionVerdict = 'MATCH' | 'NO_MATCH' | 'MATCH_CONFLICT';

export type ResolutionCandidate = {
  entityType: 'contact' | 'company';
  entityId: string;
  label: string;
  score: number;
  method: string;
  evidence: string;
};

export type EntityResolution = {
  entityType: 'contact' | 'company';
  outcome: 'auto_linked' | 'propose_create' | 'conflict' | 'human_selected';
  verdict: ResolutionVerdict;
  selectedEntityId: string | null;
  candidates: ResolutionCandidate[];
  reason: string;
};

export type ProposedAction = { type: string; payload: unknown };

export type RuleTraceEntry = { rule: string; fired: boolean; because: string };

export type DraftGuardrailViolation = { guardrail: string; evidence: string; why: string };

export type Draft = {
  subject: string;
  body: string;
  guardrailsPassed: string[];
  blockedBy: DraftGuardrailViolation[];
};

export type ActionPlan = {
  actions: ProposedAction[];
  riskTier: number;
  requiresApproval: boolean;
  approvalReasons: Array<{ code: string; message: string }>;
  rationale: string;
  ruleTrace: RuleTraceEntry[];
  draft: Draft | null;
  draftFailedReason: string | null;
};

/**
 * `superseded` (M4-C) is what a pending approval becomes when a human edits the
 * plan: the edit creates a new decision with its own approval, so this one
 * stops being pending without anyone rejecting it and without anything timing
 * out. Terminal, and never actionable.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';

export type Approval = {
  id: string;
  decisionId: string;
  state: ApprovalState;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  planHash: string | null;
  expiresAt: string;
  createdAt: string;
};

export type Execution = {
  id: string;
  sequence: number;
  actionType: string;
  status: 'pending' | 'succeeded' | 'failed' | 'skipped';
  targetType: string | null;
  targetId: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempt: number;
  finishedAt: string | null;
};

export type Outbox = {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  /**
   * `sent` is the only value that means a customer has the message, and it is
   * reachable only when the operator turned outbound sending on server-side, a
   * human approved the plan, and a provider accepted it (M4-D).
   */
  status: 'queued' | 'sent' | 'suppressed' | 'failed';
  /** Why it was held or refused. Also carries the failure kind on `failed`. */
  suppressedReason: string | null;
  /** The provider's receipt. Null unless the message was actually delivered. */
  providerMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type Decision = {
  id: string;
  emailId: string;
  analysisId: string;
  resolutionRun: string | null;
  plan: ActionPlan;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  supersededBy: string | null;
  /** The decision this one was edited from (M4-C). Null for anything the agent decided. */
  parentDecisionId: string | null;
  /** 1-based position in this email's decision history. */
  revision: number;
  origin: 'agent' | 'human_edit';
  editedBy: string | null;
  createdAt: string;
};

/**
 * One entry in an email's decision history.
 *
 * Carries the spine of the history — who produced each version and where it
 * ended up — not the plans themselves. The current revision's plan is on
 * `decision`.
 */
export type DecisionRevision = {
  id: string;
  revision: number;
  origin: 'agent' | 'human_edit';
  editedBy: string | null;
  parentDecisionId: string | null;
  createdAt: string;
  /** Null when the plan never needed an approval at all. */
  approvalState: ApprovalState | null;
  isCurrent: boolean;
};

/** One field of one action, changed by a human (FR-26). */
export type EditDiffEntry = {
  path: string;
  actionIndex: number | null;
  actionType: string | null;
  field: string;
  before: unknown;
  after: unknown;
};

/**
 * What `POST /api/decisions/:id/revise` returns.
 *
 * Note what it does NOT contain: any indication that anything was approved or
 * run. A revision ends with a *pending* approval, and still has to go through
 * the ordinary approval endpoint.
 */
export type RevisionResult = {
  decision: Decision;
  revision: number;
  parentDecisionId: string;
  approval: Approval;
  supersededApproval: Approval;
  diff: EditDiffEntry[];
  detail: EmailDetail;
};

/** One field of a plan a human may change (M4-C). Anything absent is immutable. */
export type ActionFieldEdit = {
  index: number;
  field: string;
  value: unknown;
  /** Optional assertion that the index still means what the UI thinks it means. */
  type?: string;
};

export type EditEnvelope = {
  draft?: { subject?: string; body?: string };
  actions?: ActionFieldEdit[];
};

/** One row of the approval queue (spec §13.4). */
export type ApprovalQueueRow = {
  approval: Approval;
  decision: Decision;
  email: {
    id: string;
    subject: string;
    fromName: string | null;
    fromEmail: string;
    receivedAt: string;
    state: string;
  };
  recommendation: string;
  riskTier: number;
  confidence: number | null;
  confidenceBand: string | null;
  msToExpiry: number;
  ageMs: number;
  overdue: boolean;
  actionable: boolean;
  hasDraft: boolean;
  draftBlocked: boolean;
};

export type EmailSummary = {
  id: string;
  fromName: string | null;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  state: EmailState;
  reviewReason: string | null;
  analysis: {
    category: string;
    priority: string;
    confidence: number;
    confidenceBand: 'high' | 'medium' | 'low';
    summary: string;
    injectionSuspected: boolean;
    droppedFieldCount: number;
  } | null;
  /** Null until resolution has run — never a fabricated verdict. */
  resolution: { contact: ResolutionVerdict; company: ResolutionVerdict } | null;
  /** Null until a decision exists. Never a placeholder recommendation. */
  decision: {
    actionCount: number;
    riskTier: number;
    requiresApproval: boolean;
    hasDraft: boolean;
    draftBlocked: boolean;
  } | null;
};

export type ExtractedValue = {
  value: string | null;
  confidence: number;
  sourceSpan: string | null;
};

export type Understanding = {
  category: string;
  intent: string;
  priority: string;
  priorityReason: string;
  confidence: number;
  confidenceBand: 'high' | 'medium' | 'low';
  flags: {
    insufficientInformation: boolean;
    ambiguousIntent: boolean;
    possibleInjection: boolean;
  };
  extracted: Record<string, ExtractedValue>;
  questionAsked: string | null;
  summary: string;
};

export type ValidationRecord = {
  problems: string[];
  droppedFields: Array<{ field: string; reason: string; claimedValue: string }>;
  coherenceAdjustments: Array<{ what: string; why: string }>;
  normalisations: Array<{ what: string; why: string }>;
  attempts: number;
};

export type SecurityRecord = {
  sanitisation: {
    removedHtml: boolean;
    removedScripts: number;
    removedRemoteImages: number;
    removedHiddenCharacters: number;
    truncated: boolean;
    originalLength: number;
    finalLength: number;
  };
  injection: {
    suspected: boolean;
    modelFlagged: boolean;
    matches: Array<{ rule: string; severity: string; evidence: string; why: string }>;
  };
};

export type Analysis = {
  id: string;
  emailId: string;
  understanding: Understanding;
  modelOutput: Partial<Understanding>;
  validation: ValidationRecord;
  security: SecurityRecord;
  model: string;
  promptVersion: string;
  latencyMs: number;
  attempt: number;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  sequence: number;
  stage: string;
  eventType: string;
  actor: 'system' | 'ai' | 'human';
  actorId: string | null;
  outcome: 'ok' | 'blocked' | 'failed' | 'skipped';
  summary: string;
  payload: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: string;
};

export type EmailDetail = {
  email: {
    id: string;
    fromName: string | null;
    fromEmail: string;
    toEmail: string;
    cc: string | null;
    subject: string;
    bodyText: string;
    receivedAt: string;
    state: EmailState;
    reviewReason: string | null;
    correlationId: string;
    bodyTruncated: boolean;
    threadId: string | null;
  };
  analysis: Analysis | null;
  /** Null until resolution has run. */
  resolution: { contact: EntityResolution; company: EntityResolution } | null;
  /** Null until DECIDE has run. */
  decision: Decision | null;
  /** Null until a plan needed approval. */
  approval: Approval | null;
  /** Every decision made for this email, oldest first (M4-C.3). */
  revisions: DecisionRevision[];
  /** Empty until something has actually been applied. */
  executions: Execution[];
  /** The suppressed reply, when one was queued. Never sent. */
  outbox: Outbox | null;
  audit: AuditEvent[];
  /** What later stages would show, and why they do not yet. Never fabricated. */
  stages: {
    understand: 'complete' | 'pending' | 'failed';
    resolve: 'complete' | 'pending' | 'conflict';
    decide: 'complete' | 'pending' | 'no_plan';
    execute: 'pending' | 'awaiting_approval' | 'complete' | 'failed' | 'rejected';
  };
};

// --- CRM read models (M6-C) --------------------------------------------------
//
// Mirrors of the server's projections. The relationship names (`companyName`,
// `contactName`) are resolved server-side: a join belongs in a query, not in a
// React component.

export type RecordSource = 'agent' | 'human' | 'seed';

export type DealRow = {
  id: string;
  title: string;
  stage: string;
  serviceLine: string | null;
  amountMinor: number | null;
  currency: string;
  requirementSummary: string | null;
  budgetNote: string | null;
  timelineNote: string | null;
  expectedCloseDate: string | null;
  source: RecordSource;
  createdAt: string;
  updatedAt: string;
  companyId: string | null;
  primaryContactId: string | null;
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export type ContactRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  lifecycle: string;
  source: RecordSource;
  createdAt: string;
  companyId: string | null;
  companyName: string | null;
  activityCount: number;
};

export type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeBand: string | null;
  country: string | null;
  source: RecordSource;
  createdAt: string;
  contactCount: number;
  dealCount: number;
};

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: string;
  priority: 'high' | 'medium' | 'low';
  assignee: string | null;
  source: RecordSource;
  createdAt: string;
  completedAt: string | null;
  companyName: string | null;
  contactName: string | null;
  dealTitle: string | null;
};

/** One audit event as the list shows it. Deliberately carries no payload. */
export type AuditRow = {
  id: string;
  correlationId: string;
  emailId: string | null;
  sequence: number;
  stage: string;
  eventType: string;
  actor: 'system' | 'ai' | 'human';
  actorId: string | null;
  outcome: 'ok' | 'blocked' | 'failed' | 'skipped';
  summary: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};
