-- 009_sessions.sql
-- M5-A: authenticated operator identity.
--
-- WHY THIS TABLE EXISTS
--
-- Until now the operator's name came from an `x-operator` request header, which
-- anyone could set to anything. Every approval, revision and audit event
-- therefore recorded a *claim*, not an actor — and the audit trail is one of the
-- three things this product actually sells. F-01 in the system audit.
--
-- Sessions live in the database rather than in memory for two reasons: a restart
-- should not silently log everybody out mid-approval, and a session must be
-- revocable from outside the process that issued it.
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
--
-- `token_hash`, never the token. The cookie carries a 256-bit random token; this
-- table holds only its SHA-256, and lookup hashes the presented value before
-- comparing. A leaked backup, a dump, a `SELECT *` pasted into a support thread
-- — none of them yield a usable session, because the stored value cannot be
-- replayed as a cookie. Same reasoning as never storing a plaintext password.
--
-- `csrf_token` sits alongside it because CSRF protection (M5-B) is per-session
-- by design: a token that outlives its session, or is shared between sessions,
-- is a token that keeps working after logout.
--
-- NO users TABLE.
--
-- One operator, one password, supplied through `OPERATOR_PASSWORD_HASH`. A user
-- table with a single row would be schema pretending to be a feature. When
-- multi-operator becomes real it arrives as its own migration, and `operator`
-- below is already the column it would point at.

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  operator     TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

-- Expiry is read on every authenticated request and again by the sweep, so it
-- is the one column worth an index.
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
