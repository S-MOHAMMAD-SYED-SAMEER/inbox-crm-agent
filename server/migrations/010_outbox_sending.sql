-- 010_outbox_sending.sql
-- M5-D: an explicit claim before delivery. Audit finding F-05.
--
-- WHAT WAS WRONG
--
-- The executor read the outbox row, saw it was not already `sent`, and called
-- the provider. Two executors could both read `queued` and both send, because
-- nothing between the read and the send said "this one is mine". The audit
-- probed exactly that and found one delivery — but only because the second
-- attempt happened to collide on the audit sequence constraint *before* it
-- reached the provider. That is protection by accident. Reorder the audit
-- append and duplicate customer email appears, silently.
--
-- THE FIX: A CLAIM THE DATABASE ARBITRATES
--
--   queued ──claim──► sending ──delivered──► sent
--                        │
--                        └──refused────────► failed ──retry──► sending
--
-- The claim is one conditional UPDATE. Only a row in `queued` or `failed` can
-- become `sending`, so of two concurrent executors exactly one gets rowCount 1
-- and the other gets 0 and stops. The provider is never called before that
-- UPDATE succeeds — which is the whole property.
--
-- WHY `claimed_at` IS PART OF THIS
--
-- A process that dies mid-send leaves a row in `sending` forever, and nothing
-- may deliver it because the claim is held by a process that no longer exists.
-- `claimed_at` makes staleness a fact rather than a guess, so recovery can be a
-- deterministic rule — "claimed longer ago than the timeout" — rather than an
-- operator's judgement. Recovery is a callable sweep; this build has no
-- background workers and does not need one.
--
-- WHY A REBUILD
--
-- The vocabulary lives in a CHECK constraint and SQLite cannot ALTER one. This
-- is the same portable rebuild migration 008 proved: create, copy by column
-- name, drop, rename, recreate indexes. Column order matches the live table
-- (001's definition; nothing has ALTERed it since) and the INSERT names every
-- column anyway, because matching order is a coincidence worth not depending on.

CREATE TABLE outbox_messages_new (
  id                  UUID PRIMARY KEY,
  email_id            UUID NOT NULL REFERENCES emails(id),
  decision_id         UUID NOT NULL REFERENCES decisions(id),
  to_email            TEXT NOT NULL,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','sending','sent','suppressed','failed')),
  suppressed_reason   TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  -- When the current delivery attempt took the row. Null unless `sending`.
  claimed_at          TIMESTAMPTZ
);

INSERT INTO outbox_messages_new (
  id, email_id, decision_id, to_email, subject, body,
  status, suppressed_reason, provider_message_id, created_at, sent_at, claimed_at
)
SELECT
  id, email_id, decision_id, to_email, subject, body,
  status, suppressed_reason, provider_message_id, created_at, sent_at, NULL
FROM outbox_messages;

-- Dropped before the rename so its index goes with it: index names are global
-- in Postgres, and recreating below while the original still existed would
-- collide.
DROP TABLE outbox_messages;

ALTER TABLE outbox_messages_new RENAME TO outbox_messages;

CREATE INDEX outbox_status_idx ON outbox_messages (status, created_at);

-- The stale-claim sweep reads exactly this.
CREATE INDEX outbox_claimed_idx ON outbox_messages (status, claimed_at);
