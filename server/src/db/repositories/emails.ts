import type { RepoDeps, ListOptions } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toBool, toJson, fromJson } from '../rows.ts';
import { NotFoundError } from '../../lib/errors.ts';
import type {
  CanonicalEmail,
  EmailProvider,
  EmailRecord,
  EmailState,
  ReviewReason,
} from '../../domain/email.ts';

// Email repository — ingestion storage and workflow state (FR-1..FR-3, §8).
//
// Two behaviours here carry real weight later:
//
//   * `insertIfNew` implements dedupe (FR-2) by *asking the database*, through
//     the UNIQUE (provider, provider_message_id) constraint, rather than by
//     checking first and inserting after. A check-then-insert has a race in it;
//     the constraint does not. Re-ingesting a message returns the existing row
//     and reports `created: false`, so a re-run is a no-op rather than a
//     duplicate lead.
//
//   * `setState` is the only way an email's state changes, and it takes the
//     state it expects to be leaving. That makes an illegal transition a
//     failed update rather than a silent overwrite — the foundation the §8
//     state-machine invariants are asserted against.

function mapEmail(row: Record<string, unknown>): EmailRecord {
  return {
    id: toText(row.id),
    provider: toText(row.provider) as EmailProvider,
    providerMessageId: toText(row.provider_message_id),
    threadId: toTextOrNull(row.thread_id),
    fromName: toTextOrNull(row.from_name),
    fromEmail: toText(row.from_email),
    toEmail: toText(row.to_email),
    cc: toTextOrNull(row.cc),
    subject: toText(row.subject),
    bodyText: toText(row.body_text),
    headers: toJson<Record<string, string>>(row.headers, {}),
    receivedAt: toText(row.received_at),
    ingestedAt: toText(row.ingested_at),
    state: toText(row.state) as EmailState,
    reviewReason: toTextOrNull(row.review_reason) as ReviewReason | null,
    correlationId: toText(row.correlation_id),
    bodyTruncated: toBool(row.body_truncated),
  };
}

export type InsertEmailResult = { email: EmailRecord; created: boolean };

export function createEmailRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Inserts an email unless one with the same provider message id already
     * exists. Returns the row either way, with `created` saying which happened.
     */
    async insertIfNew(email: CanonicalEmail, options: { bodyTruncated?: boolean } = {}): Promise<InsertEmailResult> {
      const existing = await this.findByProviderMessageId(email.provider, email.providerMessageId);
      if (existing) return { email: existing, created: false };

      const now = clock.nowIso();
      const values = {
        id: newId(),
        provider: email.provider,
        provider_message_id: email.providerMessageId,
        thread_id: email.threadId,
        from_name: email.fromName,
        from_email: email.fromEmail.toLowerCase(),
        to_email: email.toEmail.toLowerCase(),
        cc: email.cc,
        subject: email.subject,
        body_text: email.bodyText,
        headers: fromJson(email.headers),
        received_at: email.receivedAt,
        ingested_at: now,
        state: 'received' satisfies EmailState,
        review_reason: null,
        correlation_id: newId(),
        body_truncated: options.bodyTruncated === true,
      };

      const { sql, params } = buildInsert('emails', values);
      try {
        await db.execute(sql, params);
      } catch (err) {
        // Lost the race against a concurrent insert of the same message: the
        // unique constraint did its job, so read back the winner rather than
        // failing. Any other error is a real error and is rethrown.
        const again = await this.findByProviderMessageId(email.provider, email.providerMessageId);
        if (again) return { email: again, created: false };
        throw err;
      }

      return { email: (await this.getById(values.id)) as EmailRecord, created: true };
    },

    async getById(id: string): Promise<EmailRecord | null> {
      const rows = await db.query('SELECT * FROM emails WHERE id = ?', [id]);
      return rows[0] ? mapEmail(rows[0]) : null;
    },

    async findByProviderMessageId(provider: EmailProvider, providerMessageId: string): Promise<EmailRecord | null> {
      const rows = await db.query('SELECT * FROM emails WHERE provider = ? AND provider_message_id = ?', [
        provider,
        providerMessageId,
      ]);
      return rows[0] ? mapEmail(rows[0]) : null;
    },

    async list(options: ListOptions & { state?: EmailState } = {}): Promise<EmailRecord[]> {
      const params: Array<string | number> = [];
      let where = '';
      if (options.state) {
        where = ' WHERE state = ?';
        params.push(options.state);
      }
      const rows = await db.query(
        `SELECT * FROM emails${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(options.limit ?? 100, 500), options.offset ?? 0],
      );
      return rows.map(mapEmail);
    },

    async listByThread(threadId: string): Promise<EmailRecord[]> {
      const rows = await db.query('SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at', [threadId]);
      return rows.map(mapEmail);
    },

    /**
     * Moves an email to a new state. When `expectedFrom` is supplied the update
     * only applies if the email is still in that state, and returns null
     * otherwise — the caller decides whether losing that race is an error.
     */
    async setState(
      id: string,
      state: EmailState,
      options: { expectedFrom?: EmailState; reviewReason?: ReviewReason | null } = {},
    ): Promise<EmailRecord | null> {
      const params: Array<string | null> = [state, options.reviewReason ?? null, id];
      let sql = 'UPDATE emails SET state = ?, review_reason = ? WHERE id = ?';
      if (options.expectedFrom) {
        sql += ' AND state = ?';
        params.push(options.expectedFrom);
      }

      const result = await db.execute(sql, params);
      if (result.rowCount === 0) {
        const current = await this.getById(id);
        if (!current) throw new NotFoundError('Email');
        return null;
      }
      return (await this.getById(id)) as EmailRecord;
    },

    async countByState(): Promise<Record<string, number>> {
      const rows = await db.query<{ state: string; n: number }>(
        'SELECT state, COUNT(*) AS n FROM emails GROUP BY state',
      );
      const counts: Record<string, number> = {};
      for (const row of rows) counts[toText(row.state)] = Number(row.n);
      return counts;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM emails');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type EmailRepository = ReturnType<typeof createEmailRepository>;
