-- 001_email_workflow.sql
-- Email ingestion and the agent workflow (spec §10).
--
-- Written as PostgreSQL DDL (D1). The SQLite driver translates a closed list of
-- type tokens at migration time (src/db/dialect.ts) so the same file runs on
-- both; see that file for why, and for what the translation deliberately does
-- not do.
--
-- Conventions, all from spec §9 and all load-bearing for portability:
--   * IDs are UUIDs generated in application code — no gen_random_uuid(), no
--     pgcrypto extension.
--   * Enumerations are TEXT + CHECK, never Postgres ENUM types. The allowed
--     values are kept in step with src/domain/*.ts by a test that parses this
--     file (test/domain.schema-parity.test.ts).
--   * Timestamps are TIMESTAMPTZ here and ISO-8601 UTC text on SQLite; every
--     write supplies its own value from the injectable clock.
--   * No triggers, no stored procedures. Logic lives in TypeScript where it is
--     testable and reviewable.

CREATE TABLE emails (
  id                  UUID PRIMARY KEY,
  provider            TEXT NOT NULL CHECK (provider IN ('demo','gmail')),
  provider_message_id TEXT NOT NULL,
  thread_id           TEXT,
  from_name           TEXT,
  from_email          TEXT NOT NULL,
  to_email            TEXT NOT NULL,
  cc                  TEXT,
  subject             TEXT NOT NULL DEFAULT '',
  body_text           TEXT NOT NULL,
  headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at         TIMESTAMPTZ NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  state               TEXT NOT NULL DEFAULT 'received'
                        CHECK (state IN ('received','understanding','understand_failed',
                                         'resolving','deciding','awaiting_approval',
                                         'needs_review','executing','completed',
                                         'rejected','execution_failed','expired','archived')),
  review_reason       TEXT CHECK (review_reason IN ('low_confidence','insufficient_information',
                                                    'ambiguous_intent','match_conflict',
                                                    'possible_injection','draft_blocked',
                                                    'execution_failed','no_valid_plan',
                                                    'approval_expired')),
  correlation_id      UUID NOT NULL,
  UNIQUE (provider, provider_message_id)
);

CREATE INDEX emails_state_received_idx ON emails (state, received_at DESC);
CREATE INDEX emails_thread_idx         ON emails (thread_id);
CREATE INDEX emails_from_idx           ON emails (from_email);

CREATE TABLE email_analyses (
  id                UUID PRIMARY KEY,
  email_id          UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN ('sales_inquiry','service_inquiry',
                                                      'pricing_request','support_request',
                                                      'follow_up','partnership','vendor_pitch',
                                                      'spam','ambiguous')),
  intent            TEXT NOT NULL,
  priority          TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
  priority_reason   TEXT NOT NULL,
  confidence        NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  confidence_band   TEXT NOT NULL CHECK (confidence_band IN ('high','medium','low')),
  flags             JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted         JSONB NOT NULL,
  summary           TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  latency_ms        INTEGER NOT NULL,
  attempt           SMALLINT NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_analyses_email_idx ON email_analyses (email_id, created_at DESC);

CREATE TABLE entity_matches (
  id            UUID PRIMARY KEY,
  email_id      UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('contact','company','deal')),
  entity_id     UUID,
  score         NUMERIC(4,3) NOT NULL,
  method        TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('auto_linked','propose_create',
                                                 'conflict','human_selected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entity_matches_email_idx ON entity_matches (email_id);

CREATE TABLE decisions (
  id                 UUID PRIMARY KEY,
  email_id           UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  analysis_id        UUID NOT NULL REFERENCES email_analyses(id),
  actions            JSONB NOT NULL,
  risk_tier          SMALLINT NOT NULL CHECK (risk_tier IN (0,1,2)),
  requires_approval  BOOLEAN NOT NULL,
  rationale          TEXT NOT NULL,
  rule_trace         JSONB NOT NULL,
  draft_subject      TEXT,
  draft_body         TEXT,
  draft_blocked_by   JSONB NOT NULL DEFAULT '[]'::jsonb,
  model              TEXT,
  prompt_version     TEXT,
  latency_ms         INTEGER,
  superseded_by      UUID REFERENCES decisions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX decisions_email_idx ON decisions (email_id, created_at DESC);

CREATE TABLE approvals (
  id             UUID PRIMARY KEY,
  decision_id    UUID NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE CASCADE,
  state          TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired')),
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  reason         TEXT,
  edited_actions JSONB,
  edited_draft   JSONB,
  edit_diff      JSONB,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX approvals_pending_idx ON approvals (state, expires_at);

CREATE TABLE action_executions (
  id              UUID PRIMARY KEY,
  decision_id     UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  sequence        SMALLINT NOT NULL,
  action_type     TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','skipped')),
  target_type     TEXT,
  target_id       UUID,
  before_snapshot JSONB,
  after_snapshot  JSONB,
  error_code      TEXT,
  error_message   TEXT,
  attempt         SMALLINT NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE INDEX action_executions_decision_idx ON action_executions (decision_id, sequence);

CREATE TABLE outbox_messages (
  id                  UUID PRIMARY KEY,
  email_id            UUID NOT NULL REFERENCES emails(id),
  decision_id         UUID NOT NULL REFERENCES decisions(id),
  to_email            TEXT NOT NULL,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','sent','suppressed','failed')),
  suppressed_reason   TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

CREATE INDEX outbox_status_idx ON outbox_messages (status, created_at);
