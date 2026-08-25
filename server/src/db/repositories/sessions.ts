import type { RepoDeps } from './crm.ts';
import { buildInsert } from './helpers.ts';
import { toText } from '../rows.ts';
import { createSessionToken, hashSessionToken, type SessionRecord } from '../../domain/session.ts';

// Session persistence (M5-A).
//
// Every method that takes a token hashes it before touching the database, and
// no method returns a token. The only place a raw token exists is the return
// value of `create`, which the login handler puts straight into a Set-Cookie
// header and never logs.
//
// Note what is absent: no "list all sessions", no lookup by operator, no update
// of anything except `last_seen_at`. A session is a bearer credential, and the
// fewer ways there are to enumerate or mutate one, the fewer ways there are to
// get that wrong.

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    tokenHash: toText(row.token_hash),
    operator: toText(row.operator),
    csrfToken: toText(row.csrf_token),
    createdAt: toText(row.created_at),
    expiresAt: toText(row.expires_at),
    lastSeenAt: toText(row.last_seen_at),
  };
}

export function createSessionRepository({ db, clock }: RepoDeps) {
  return {
    /**
     * Opens a session and returns the token exactly once.
     *
     * The caller sets it as a cookie and forgets it. There is no way to read it
     * back out of this repository afterwards, which is the intended shape: if
     * the token could be recovered from storage, storing the hash would have
     * bought nothing.
     */
    async create(operator: string, ttlHours: number): Promise<{ token: string; session: SessionRecord }> {
      const now = clock.nowIso();
      const token = createSessionToken();
      const tokenHash = hashSessionToken(token);

      const values = {
        token_hash: tokenHash,
        operator,
        csrf_token: createSessionToken(),
        created_at: now,
        expires_at: new Date(Date.parse(now) + ttlHours * 3600_000).toISOString(),
        last_seen_at: now,
      };

      const { sql, params } = buildInsert('sessions', values);
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
      return { token, session: mapSession(rows[0] as Record<string, unknown>) };
    },

    /**
     * Finds a live session for a presented token.
     *
     * Expiry is applied in the query, so an expired session is indistinguishable
     * from a missing one to every caller. That is deliberate: a caller that
     * could tell them apart would eventually branch on it, and "expired" and
     * "never existed" both mean exactly one thing here — not authenticated.
     */
    async findLive(token: string, now: string): Promise<SessionRecord | null> {
      const rows = await db.query('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', [
        hashSessionToken(token),
        now,
      ]);
      return rows[0] ? mapSession(rows[0]) : null;
    },

    /** Records activity. Never extends expiry — a session has a fixed lifetime. */
    async touch(tokenHash: string): Promise<void> {
      await db.execute('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [clock.nowIso(), tokenHash]);
    },

    /** Logout. Deleting rather than flagging: a revoked session should stop existing. */
    async revoke(token: string): Promise<boolean> {
      const result = await db.execute('DELETE FROM sessions WHERE token_hash = ?', [hashSessionToken(token)]);
      return result.rowCount > 0;
    },

    /**
     * Removes expired rows.
     *
     * Housekeeping only — `findLive` already refuses them, so this table growing
     * is a storage question and never a security one. Called opportunistically
     * at login rather than by a background worker, because this build has no
     * workers and does not need one for a table of this size.
     */
    async deleteExpired(now: string): Promise<number> {
      const result = await db.execute('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      return result.rowCount;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
