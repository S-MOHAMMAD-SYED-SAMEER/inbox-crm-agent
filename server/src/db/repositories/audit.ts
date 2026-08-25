import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { boundAuditPayload } from '../../domain/auditPayload.ts';
import { toText, toTextOrNull, toNumber, toNumberOrNull, toJson, fromJson } from '../rows.ts';
import type {
  AuditActor,
  AuditEvent,
  AuditEventInput,
  AuditEventType,
  AuditOutcome,
  AuditStage,
} from '../../domain/audit.ts';

// Audit repository (§17, FR-38..FR-41).
//
// THE INTERFACE IS THE GUARANTEE.
//
// This module exports `append` and read methods. There is no `update`, no
// `delete`, no `upsert`, and no escape hatch, so "the audit log is append-only"
// is not a policy someone has to remember — it is the absence of a function to
// call. That is why the guarantee lives here rather than in a database trigger:
// it survives code review, it is testable without a database, it is identical
// on both drivers, and violating it requires writing new code that an
// architecture test would catch.
//
// SEQUENCE NUMBERS
//
// Each event carries a monotonic `sequence` within its `correlation_id`, and
// the pair is UNIQUE in the schema. That makes gaps and reordering detectable
// rather than invisible: an audit trail whose events cannot be ordered is a
// pile of log lines, and the difference matters the moment someone asks what
// happened *before* the CRM was updated.

function mapEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: toText(row.id),
    correlationId: toText(row.correlation_id),
    emailId: toTextOrNull(row.email_id),
    sequence: toNumber(row.sequence),
    stage: toText(row.stage) as AuditStage,
    eventType: toText(row.event_type) as AuditEventType,
    actor: toText(row.actor) as AuditActor,
    actorId: toTextOrNull(row.actor_id),
    outcome: toText(row.outcome) as AuditOutcome,
    summary: toText(row.summary),
    payload: toJson<Record<string, unknown>>(row.payload, {}),
    entityType: toTextOrNull(row.entity_type),
    entityId: toTextOrNull(row.entity_id),
    latencyMs: toNumberOrNull(row.latency_ms),
    createdAt: toText(row.created_at),
  };
}

export function createAuditRepository({ db, clock, newId }: RepoDeps) {
  return {
    async append(input: AuditEventInput): Promise<AuditEvent> {
      // The sequence is derived inside the same transaction as the insert so
      // two concurrent appends to one run cannot land on the same number. If
      // they somehow do, the UNIQUE constraint rejects the second — an audit
      // trail that loses an event silently would be worse than one that errors.
      return db.transaction(async (tx) => {
        const rows = await tx.query<{ next: number | null }>(
          'SELECT MAX(sequence) AS next FROM audit_events WHERE correlation_id = ?',
          [input.correlationId],
        );
        const sequence = Number(rows[0]?.next ?? 0) + 1;

        const values = {
          id: newId(),
          correlation_id: input.correlationId,
          email_id: input.emailId ?? null,
          sequence,
          stage: input.stage,
          event_type: input.eventType,
          actor: input.actor,
          actor_id: input.actorId ?? null,
          outcome: input.outcome,
          summary: input.summary,
          // Bounded before storage (M5-F, audit F-13). Identifiers survive
          // intact; anything else is capped and the truncation is marked.
          payload: fromJson(boundAuditPayload(input.payload).payload),
          entity_type: input.entityType ?? null,
          entity_id: input.entityId ?? null,
          latency_ms: input.latencyMs ?? null,
          created_at: clock.nowIso(),
        };

        const { sql, params } = buildInsert('audit_events', values);
        await tx.execute(sql, params);

        const inserted = await tx.query('SELECT * FROM audit_events WHERE id = ?', [values.id]);
        return mapEvent(inserted[0] as Record<string, unknown>);
      });
    },

    /** Every event in one processing run, in order. The Audit Log screen's unit of display. */
    async listByCorrelation(correlationId: string): Promise<AuditEvent[]> {
      const rows = await db.query(
        'SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY sequence',
        [correlationId],
      );
      return rows.map(mapEvent);
    },

    async listByEmail(emailId: string): Promise<AuditEvent[]> {
      const rows = await db.query(
        'SELECT * FROM audit_events WHERE email_id = ? ORDER BY created_at, sequence',
        [emailId],
      );
      return rows.map(mapEvent);
    },

    async list(
      filters: {
        actor?: AuditActor;
        stage?: AuditStage;
        outcome?: AuditOutcome;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<AuditEvent[]> {
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      if (filters.actor) {
        conditions.push('actor = ?');
        params.push(filters.actor);
      }
      if (filters.stage) {
        conditions.push('stage = ?');
        params.push(filters.stage);
      }
      if (filters.outcome) {
        conditions.push('outcome = ?');
        params.push(filters.outcome);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.query(
        `SELECT * FROM audit_events${where} ORDER BY created_at DESC, sequence DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(filters.limit ?? 100, 500), filters.offset ?? 0],
      );
      return rows.map(mapEvent);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;
