-- 006_decision.sql
-- M3: record *why* a decision required approval, and what the draft survived.
--
-- WHY THESE COLUMNS
--
-- M0 created `decisions` with the plan, its risk tier, the approval flag, the
-- rationale and the rule trace. That covers what was decided. It does not cover
-- three things M3 needs to be able to answer:
--
--   1. "Why does this need me?" `requires_approval` is a boolean; the operator
--      needs the specific triggering reasons (§13.3 requires the UI to state the
--      trigger, never just "this is risky"). The policy already computes them —
--      they just had nowhere to live.
--   2. "Which CRM match was this based on?" `analysis_id` links the reading;
--      nothing linked the resolution run, so a decision and the entity match it
--      relied on could not be lined up afterwards.
--   3. "Was the draft checked, or did drafting simply fail?" A draft that passed
--      every guardrail and a draft that was never produced both leave
--      `draft_body` populated-or-null with no way to tell them apart.
--
-- No new tables and no new entities: four columns on the table M0 created for
-- exactly this purpose, matching the pattern of migrations 004 and 005.

ALTER TABLE decisions ADD COLUMN resolution_run          UUID;
ALTER TABLE decisions ADD COLUMN approval_reasons        JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE decisions ADD COLUMN draft_guardrails_passed JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Set only when the drafting model could not be reached or returned something
-- unusable. A failure to draft never fails the decision: the plan is
-- deterministic and already computed, so the email goes to a person to write
-- the reply rather than losing the work.
ALTER TABLE decisions ADD COLUMN draft_failed_reason     TEXT;

CREATE INDEX decisions_pending_idx ON decisions (requires_approval, created_at DESC);
