-- 007_approval_binding.sql
-- M4-A: bind an approval to the exact plan a person saw.
--
-- WHY THIS COLUMN EXISTS
--
-- `approvals.decision_id` already ties an approval to a decision, and decisions
-- are immutable (a re-decide writes a new row and supersedes the old one). That
-- is most of the protection, but it is not all of it: it proves *which record*
-- was approved, not *what that record said* at the time.
--
-- `plan_hash` closes the gap. It is a fingerprint of the actions and the draft
-- taken at the moment of approval, re-computed and compared by the executor
-- before anything is applied. If a plan is ever altered in place — by a bug, a
-- migration, or a hand-edited row — the fingerprints disagree and execution
-- refuses rather than running something nobody approved.
--
-- The property being defended: a human must never be able to accidentally
-- authorise a plan other than the one they read.

ALTER TABLE approvals ADD COLUMN plan_hash TEXT;

CREATE INDEX approvals_state_idx ON approvals (state, created_at DESC);
