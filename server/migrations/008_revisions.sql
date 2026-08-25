-- 008_revisions.sql
-- M4-C: let a human edit a plan without ever editing the plan they were shown.
--
-- WHY THIS EXISTS
--
-- Approve-with-edits (FR-23, FR-26) has one hard requirement: the AI's original
-- proposal must survive the edit intact, because that pair — what the model
-- said, what the human changed it to — is the labelled training signal §20's
-- feedback loop is built on. Mutating the decision in place would destroy the
-- more valuable half of it.
--
-- So an edit does not modify a decision. It writes a NEW decision that
-- supersedes the old one, exactly as a re-decide already does (M3), and the old
-- row is never touched again. `decisions` already had `superseded_by` for this
-- purpose; what it lacked was any way to say who made the new row and what it
-- came from.
--
-- FOUR COLUMNS ON `decisions`
--
--   parent_decision_id  the backward link. `superseded_by` points forward, and
--                       one is not reliably derivable from the other once an
--                       agent re-decide and a human edit interleave: both set
--                       `superseded_by`, only one has a parent.
--   revision            1-based position in this email's decision history, so
--                       the UI can say "v2" without counting rows.
--   origin              'agent' or 'human_edit'. The distinction the two links
--                       above cannot carry on their own, and the thing the
--                       audit trail is actually asked about.
--   edited_by           who made the edit. Null for anything the agent decided.
--
-- ONE NEW APPROVAL STATE
--
-- When a revision is created, the original's pending approval must stop being
-- pending. Leaving it pending is not an option: the expiry sweep (M4-B) would
-- find it, expire it, and drag the email to `needs_review` — even though the
-- email is legitimately awaiting approval on the revision. Nor can it be
-- `rejected` (nobody rejected anything) or `expired` (nothing timed out).
--
-- `superseded` is the honest fifth state, and it is terminal like the other
-- three. The alternative considered and rejected was keeping four states and
-- filtering stale approvals with a join on `decisions.superseded_by IS NULL`
-- everywhere they are read — cheaper today, but it makes correctness depend on
-- every future query remembering the join. A state that describes itself does
-- not have that failure mode.
--
-- WHY THIS ONE IS A TABLE REBUILD
--
-- Every migration before this one was additive. This one cannot be: the state
-- vocabulary lives in a CHECK constraint, SQLite cannot ALTER a CHECK, and the
-- constraint is the thing making the vocabulary real. The rebuild below is the
-- portable form of the change — it is the same sequence in both engines, runs
-- inside the migration's single transaction, and copies every column by name
-- rather than by position so a future ALTER cannot silently misalign it.

ALTER TABLE decisions ADD COLUMN parent_decision_id UUID REFERENCES decisions(id);
ALTER TABLE decisions ADD COLUMN revision           SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE decisions ADD COLUMN origin             TEXT NOT NULL DEFAULT 'agent'
                                                    CHECK (origin IN ('agent','human_edit'));
ALTER TABLE decisions ADD COLUMN edited_by          TEXT;

-- Every decision that exists today was made by the agent, is the first of its
-- line, and has no parent — which is exactly what the defaults above give them.

CREATE INDEX decisions_parent_idx ON decisions (parent_decision_id);

-- --- approvals.state gains 'superseded' -------------------------------------
--
-- Column order matches the live table (001's definition, then 007's plan_hash)
-- so the new table is a faithful copy, but the INSERT names every column anyway
-- because matching order is a coincidence worth not depending on.

CREATE TABLE approvals_new (
  id             UUID PRIMARY KEY,
  decision_id    UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE CASCADE,
  state          TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired','superseded')),
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  reason         TEXT,
  edited_actions JSONB,
  edited_draft   JSONB,
  edit_diff      JSONB,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan_hash      TEXT
);

INSERT INTO approvals_new (
  id, decision_id, state, decided_by, decided_at, reason,
  edited_actions, edited_draft, edit_diff, expires_at, created_at, plan_hash
)
SELECT
  id, decision_id, state, decided_by, decided_at, reason,
  edited_actions, edited_draft, edit_diff, expires_at, created_at, plan_hash
FROM approvals;

-- Dropped before the rename so the old indexes go with it: index names are
-- global in Postgres, and recreating them below while the originals still
-- existed would collide.
DROP TABLE approvals;

ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX approvals_pending_idx ON approvals (state, expires_at);
CREATE INDEX approvals_state_idx   ON approvals (state, created_at DESC);
