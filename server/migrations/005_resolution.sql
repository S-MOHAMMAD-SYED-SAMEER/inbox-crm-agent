-- 005_resolution.sql
-- M2: make `entity_matches` able to record a whole resolution run, not just
-- one candidate at a time.
--
-- WHY THESE COLUMNS
--
-- M0 created `entity_matches` with one row per candidate: entity, score,
-- method, evidence, outcome. That is the right shape, but it cannot answer
-- three questions the resolution stage has to be able to answer:
--
--   1. "Which candidates were considered together?" Without a run identifier,
--      candidates from a re-resolution are indistinguishable from the original
--      ones — and re-resolution is expected, because a human resolving a
--      conflict produces a second run over the same email.
--   2. "Which one won?" `outcome` describes the *run's* verdict, so it cannot
--      also mark which row was selected. A conflict run has no winner at all.
--   3. "Which reading of the email was this based on?" Resolution consumes an
--      analysis (M1); without the reference, a resolution and the understanding
--      that produced it cannot be lined up after the fact.
--
-- `rank` is stored rather than derived from score so the ordering shown to an
-- operator is fixed at the time of the decision. Two candidates can tie on
-- score — that is precisely the conflict case — and a UI that re-sorted them
-- differently on each read would look like it was changing its mind.
--
-- No new tables and no new entities: four columns on the table M0 already
-- created for exactly this purpose. The table is empty by construction — M2 is
-- the first code that writes to it — so nullable columns here carry no legacy
-- rows, and the repository always supplies them.

ALTER TABLE entity_matches ADD COLUMN resolution_run UUID;
ALTER TABLE entity_matches ADD COLUMN analysis_id    UUID REFERENCES email_analyses(id);
ALTER TABLE entity_matches ADD COLUMN rank           SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE entity_matches ADD COLUMN selected       BOOLEAN NOT NULL DEFAULT FALSE;

-- The run's verdict in one sentence, stored per row alongside `outcome` for the
-- same reason: a candidate row read on its own should describe the decision it
-- belonged to. `evidence` explains one candidate; `reason` explains the run —
-- and for a conflict, the run's reason is the only thing that mentions BOTH
-- candidates, which is the part an operator actually needs.
ALTER TABLE entity_matches ADD COLUMN reason TEXT;

CREATE INDEX entity_matches_run_idx ON entity_matches (resolution_run, rank);
