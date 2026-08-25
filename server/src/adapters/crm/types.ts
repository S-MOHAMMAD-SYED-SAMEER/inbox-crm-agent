import type { CrmTargetName } from '../../config/env.ts';
import type { Activity, Company, Contact, Deal, Note, Task } from '../../domain/crm.ts';
import type { ProposedAction } from '../../domain/actions.ts';

// The CRM boundary (spec §15, §24).
//
// SPEC REFINEMENT — the interface is split in two.
//
// §15 describes one `CrmAdapter` with reads and `applyPlan` together. It is
// split here into `CrmReader` (implemented now) and `CrmWriter` (M4, with the
// EXECUTE stage), with `CrmAdapter = CrmReader & CrmWriter` preserving the
// original shape. The alternative was shipping an `applyPlan` that throws
// "not implemented" — a runtime landmine in the one code path where a mistake
// writes wrong data to a customer's CRM. A type that says what exists cannot
// be called by accident; a stub that throws can.
//
// WHY `applyPlan` IS ONE METHOD, NOT SIX
//
// Because atomicity is the *adapter's* contract, not the caller's problem.
// The local adapter satisfies it with a database transaction. HubSpot cannot:
// its API has no cross-object transaction, so that adapter will declare
// `supportsAtomicity: false` and implement compensating rollback — and the
// policy layer will require approval for multi-action plans on it (§16 rule 7).
// Discovering that in the design is the entire payoff of drawing the boundary
// before writing the integration.

export type CrmEntitySnapshot = Company | Contact | Deal | Task | Activity | Note;

export type TimelineItem = {
  kind: 'activity' | 'note' | 'task' | 'email';
  id: string;
  occurredAt: string;
  title: string;
  body: string | null;
  source: string;
};

export type CrmReader = {
  readonly name: CrmTargetName;
  /**
   * Whether this adapter can apply a multi-action plan atomically. Read by the
   * approval policy: an adapter that cannot guarantee all-or-nothing must not
   * apply a multi-step plan unattended.
   */
  readonly supportsAtomicity: boolean;

  findContactByEmail(email: string): Promise<Contact | null>;
  findCompanyByDomain(domain: string): Promise<Company | null>;
  searchCompaniesByName(nameNorm: string): Promise<Company[]>;
  getTimeline(entityType: 'contact' | 'company' | 'deal', id: string): Promise<TimelineItem[]>;
};

export type ExecutionContext = {
  correlationId: string;
  emailId: string;
  decisionId: string;
  approvedBy: string | null;
};

export type ActionResult = {
  sequence: number;
  actionType: string;
  status: 'succeeded' | 'failed' | 'skipped';
  targetType?: string;
  targetId?: string;
  errorCode?: string;
  errorMessage?: string;
};

/** Implemented in M4 with the EXECUTE stage. */
export type CrmWriter = {
  applyPlan(actions: readonly ProposedAction[], context: ExecutionContext): Promise<ActionResult[]>;
};

export type CrmAdapter = CrmReader & CrmWriter;
