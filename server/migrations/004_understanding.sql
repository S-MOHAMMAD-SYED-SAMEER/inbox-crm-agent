-- 004_understanding.sql
-- M1: keep the four different kinds of "what we know about this email" apart.
--
-- WHY THESE COLUMNS EXIST
--
-- M0 gave `email_analyses` one `flags` column. That is enough only if you are
-- willing to blur four things that must never be confused:
--
--   1. `model_output`  — what the model actually said, before anything touched it.
--   2. `flags`         — the EFFECTIVE flags, after deterministic validation had
--                        its say. These are what the rest of the system reads.
--   3. `validation`    — what deterministic code did to the model's answer: which
--                        fields it dropped for lacking provenance, which
--                        incoherences it corrected, what problems it found.
--   4. `security`      — what the sanitiser removed and what the injection
--                        detector found. Independent of the model entirely.
--
-- Storing only the effective result would make the system unexplainable in the
-- one situation where explanation matters most: "why did it ignore the budget
-- that was clearly in my email?" With `model_output` and `validation` side by
-- side, the answer is a diff rather than an opinion.
--
-- No new entities and no new tables — three JSON columns on the table M0
-- already created for exactly this purpose.

ALTER TABLE email_analyses ADD COLUMN model_output JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE email_analyses ADD COLUMN validation   JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE email_analyses ADD COLUMN security     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The truncation marker from ingestion (FR-4 / spec §18 "email too large").
-- Recorded on the email itself, because it is a fact about the stored body
-- rather than about any one analysis of it.
ALTER TABLE emails ADD COLUMN body_truncated BOOLEAN NOT NULL DEFAULT FALSE;

-- `questionAsked` is part of the Understanding shape in spec §7, and the M0
-- schema had no column for it. Storing it only inside `model_output` would mean
-- the effective understanding and the raw model answer disagreed about where a
-- field lives — and the whole point of these columns is that those two things
-- stay cleanly separable.
ALTER TABLE email_analyses ADD COLUMN question_asked TEXT;
