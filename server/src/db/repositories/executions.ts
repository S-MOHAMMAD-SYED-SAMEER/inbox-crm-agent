import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toJson, fromJson } from '../rows.ts';
import type { ActionType } from '../../domain/actions.ts';
import type {
  ExecutionRecord,
  ExecutionStatus,
  OutboxRecord,
  OutboxStatus,
} from '../../domain/execution.ts';

// Execution and outbox persistence (FR-29, FR-32, FR-33).
//
// Append-only: an execution row is written once, when the attempt finishes.
// There is no update method, so "it succeeded, then later it says it failed"
// is not a state this system can reach.
//
// Idempotency is the database's job, not this module's. `idempotency_key` is
// UNIQUE, so a duplicate insert raises rather than writing a second row — and
// `recordIfNew` reports which happened instead of swallowing it.

function mapExecution(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: toText(row.id),
    decisionId: toText(row.decision_id),
    sequence: toNumber(row.sequence),
    actionType: toText(row.action_type) as ActionType,
    status: toText(row.status) as ExecutionStatus,
    targetType: toTextOrNull(row.target_type),
    targetId: toTextOrNull(row.target_id),
    beforeSnapshot: toJson<Record<string, unknown> | null>(row.before_snapshot, null),
    afterSnapshot: toJson<Record<string, unknown> | null>(row.after_snapshot, null),
    errorCode: toTextOrNull(row.error_code),
    errorMessage: toTextOrNull(row.error_message),
    attempt: toNumber(row.attempt),
    idempotencyKey: toText(row.idempotency_key),
    startedAt: toTextOrNull(row.started_at),
    finishedAt: toTextOrNull(row.finished_at),
  };
}

function mapOutbox(row: Record<string, unknown>): OutboxRecord {
  return {
    id: toText(row.id),
    emailId: toText(row.email_id),
    decisionId: toText(row.decision_id),
    toEmail: toText(row.to_email),
    subject: toText(row.subject),
    body: toText(row.body),
    status: toText(row.status) as OutboxStatus,
    suppressedReason: toTextOrNull(row.suppressed_reason),
    providerMessageId: toTextOrNull(row.provider_message_id),
    createdAt: toText(row.created_at),
    sentAt: toTextOrNull(row.sent_at),
    claimedAt: toTextOrNull(row.claimed_at),
  };
}

export type RecordExecutionInput = {
  decisionId: string;
  sequence: number;
  actionType: string;
  payload: unknown;
  status: ExecutionStatus;
  idempotencyKey: string;
  targetType?: string | null;
  targetId?: string | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attempt?: number;
  startedAt?: string | null;
};

export function createExecutionRepository({ db, clock, newId }: RepoDeps) {
  return {
    async record(input: RecordExecutionInput): Promise<ExecutionRecord> {
      const values = {
        id: newId(),
        decision_id: input.decisionId,
        sequence: input.sequence,
        action_type: input.actionType,
        payload: fromJson(input.payload),
        status: input.status,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        before_snapshot: input.beforeSnapshot === undefined ? null : fromJson(input.beforeSnapshot),
        after_snapshot: input.afterSnapshot === undefined ? null : fromJson(input.afterSnapshot),
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        attempt: input.attempt ?? 1,
        idempotency_key: input.idempotencyKey,
        started_at: input.startedAt ?? clock.nowIso(),
        finished_at: clock.nowIso(),
      };

      const { sql, params } = buildInsert('action_executions', values);
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM action_executions WHERE id = ?', [values.id]);
      return mapExecution(rows[0] as Record<string, unknown>);
    },

    /** Whether this exact action of this exact decision already ran successfully. */
    async findByIdempotencyKey(key: string): Promise<ExecutionRecord | null> {
      const rows = await db.query('SELECT * FROM action_executions WHERE idempotency_key = ?', [key]);
      return rows[0] ? mapExecution(rows[0]) : null;
    },

    async listForDecision(decisionId: string): Promise<ExecutionRecord[]> {
      const rows = await db.query(
        'SELECT * FROM action_executions WHERE decision_id = ? ORDER BY sequence, attempt',
        [decisionId],
      );
      return rows.map(mapExecution);
    },

    /** The highest attempt number recorded for a decision — used when retrying. */
    async lastAttempt(decisionId: string): Promise<number> {
      const rows = await db.query<{ n: number | null }>(
        'SELECT MAX(attempt) AS n FROM action_executions WHERE decision_id = ?',
        [decisionId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM action_executions');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type CreateOutboxInput = {
  emailId: string;
  decisionId: string;
  toEmail: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  suppressedReason: string | null;
};

export function createOutboxRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Places a reply in the outbox.
     *
     * The outbox is the durable delivery boundary (§15): a reply exists here,
     * inspectable, before anything tries to deliver it, and its status is the
     * single answer to "did this actually go out?". `suppressed` means the
     * system was not permitted to send; `sent` means a provider accepted it;
     * `failed` means one refused. Nothing else may claim delivery.
     */
    async create(input: CreateOutboxInput): Promise<OutboxRecord> {
      const values = {
        id: newId(),
        email_id: input.emailId,
        decision_id: input.decisionId,
        to_email: input.toEmail,
        subject: input.subject,
        body: input.body,
        status: input.status,
        suppressed_reason: input.suppressedReason,
        provider_message_id: null,
        created_at: clock.nowIso(),
        sent_at: null,
        claimed_at: null,
      };

      const { sql, params } = buildInsert('outbox_messages', values);
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM outbox_messages WHERE id = ?', [values.id]);
      return mapOutbox(rows[0] as Record<string, unknown>);
    },

    /**
     * Claims a message for one delivery attempt (M5-D, audit F-05).
     *
     * THE CONCURRENCY GUARANTEE LIVES IN THIS ONE STATEMENT.
     *
     * Only `queued` or `failed` can become `sending`, and the database decides
     * which caller wins. Two executors racing the same message both run this
     * UPDATE; exactly one gets `rowCount === 1` and proceeds to the provider,
     * the other gets 0 and stops. Nothing between the read and the send is left
     * to ordering luck.
     *
     * `sent` and `suppressed` are excluded, so a delivered message can never be
     * re-claimed, and `sending` is excluded, so a claim in flight is respected.
     *
     * Returns the claimed row, or null when somebody else holds it.
     */
    async claimForSending(id: string): Promise<OutboxRecord | null> {
      const result = await db.execute(
        `UPDATE outbox_messages
            SET status = 'sending', claimed_at = ?, suppressed_reason = NULL
          WHERE id = ? AND status IN ('queued','failed')`,
        [clock.nowIso(), id],
      );
      if (result.rowCount === 0) return null;

      const rows = await db.query('SELECT * FROM outbox_messages WHERE id = ?', [id]);
      return rows[0] ? mapOutbox(rows[0]) : null;
    },

    /**
     * Returns stale claims to `failed` so they can be retried.
     *
     * A process that dies mid-send leaves a row in `sending` that nothing may
     * deliver, because the claim belongs to a process that no longer exists.
     * The rule is deterministic and stated in one place: a claim older than
     * `timeoutMs` is stale. It is a callable sweep rather than a background
     * worker, matching the rest of this build.
     *
     * Recovery moves to `failed`, never to `sent`: whether the provider
     * actually delivered before the crash is unknowable from here, and the
     * safe reading of "unknown" is "not delivered, ask a person". A retry that
     * double-sends is a worse outcome than a reply that goes out late, which is
     * why recovery does not re-claim automatically.
     */
    async recoverStaleSending(timeoutMs: number, now?: string): Promise<OutboxRecord[]> {
      const at = now ?? clock.nowIso();
      const cutoff = new Date(Date.parse(at) - timeoutMs).toISOString();

      const stale = await db.query(
        "SELECT * FROM outbox_messages WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at <= ?",
        [cutoff],
      );
      if (stale.length === 0) return [];

      await db.execute(
        `UPDATE outbox_messages
            SET status = 'failed', suppressed_reason = 'sending_timed_out', claimed_at = NULL
          WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        [cutoff],
      );

      return stale.map(mapOutbox);
    },

    /**
     * Records a successful delivery (M4-D).
     *
     * Write-once, guarded in the WHERE clause: only a message that is not
     * already `sent` can become `sent`. A double execution therefore cannot
     * produce two deliveries or two timestamps, and the guard is the database's
     * rather than the caller's.
     */
    async markSent(id: string, providerMessageId: string): Promise<OutboxRecord | null> {
      const result = await db.execute(
        `UPDATE outbox_messages
            SET status = 'sent', provider_message_id = ?, sent_at = ?, suppressed_reason = NULL, claimed_at = NULL
          WHERE id = ? AND status <> 'sent'`,
        [providerMessageId, clock.nowIso(), id],
      );
      if (result.rowCount === 0) return null;

      const rows = await db.query('SELECT * FROM outbox_messages WHERE id = ?', [id]);
      return rows[0] ? mapOutbox(rows[0]) : null;
    },

    /**
     * Records a refused delivery.
     *
     * `sent_at` stays null and the status stays `failed`: a failed attempt must
     * never be able to read as a delivery, which is why this cannot touch a row
     * that already succeeded.
     */
    async markFailed(id: string, reason: string): Promise<OutboxRecord | null> {
      const result = await db.execute(
        `UPDATE outbox_messages
            SET status = 'failed', suppressed_reason = ?, sent_at = NULL, claimed_at = NULL
          WHERE id = ? AND status <> 'sent'`,
        [reason, id],
      );
      if (result.rowCount === 0) return null;

      const rows = await db.query('SELECT * FROM outbox_messages WHERE id = ?', [id]);
      return rows[0] ? mapOutbox(rows[0]) : null;
    },

    async findForDecision(decisionId: string): Promise<OutboxRecord | null> {
      const rows = await db.query(
        'SELECT * FROM outbox_messages WHERE decision_id = ? ORDER BY created_at DESC LIMIT 1',
        [decisionId],
      );
      return rows[0] ? mapOutbox(rows[0]) : null;
    },

    async listByStatus(status: OutboxStatus, limit = 100): Promise<OutboxRecord[]> {
      const rows = await db.query(
        'SELECT * FROM outbox_messages WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        [status, Math.min(limit, 500)],
      );
      return rows.map(mapOutbox);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_messages');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type ExecutionRepository = ReturnType<typeof createExecutionRepository>;
export type OutboxRepository = ReturnType<typeof createOutboxRepository>;
