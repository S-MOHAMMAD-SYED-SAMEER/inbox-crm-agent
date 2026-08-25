-- 003_audit_and_settings.sql
-- Audit trail and operator settings (spec §10, §17, FR-38..FR-41).
--
-- Append-only is enforced in the repository layer (src/db/repositories/audit.ts
-- exposes append() and reads, and nothing else) rather than by a database
-- trigger. That choice is deliberate: the guarantee is then visible in code
-- review, testable without a database, portable to SQLite, and impossible to
-- bypass through a repository that offers no other method. A production
-- deployment would additionally REVOKE UPDATE, DELETE on this table; that is a
-- hardening step for the milestone that provisions a real database, not
-- something a local demo can meaningfully assert.

CREATE TABLE audit_events (
  id             UUID PRIMARY KEY,
  correlation_id UUID NOT NULL,
  email_id       UUID REFERENCES emails(id) ON DELETE SET NULL,
  sequence       INTEGER NOT NULL,
  stage          TEXT NOT NULL CHECK (stage IN ('ingest','understand','resolve','decide',
                                                'policy','approval','execute','crm_write',
                                                'outbox','system')),
  event_type     TEXT NOT NULL,
  actor          TEXT NOT NULL CHECK (actor IN ('system','ai','human')),
  actor_id       TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','blocked','failed','skipped')),
  summary        TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_type    TEXT,
  entity_id      UUID,
  latency_ms     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (correlation_id, sequence)
);

CREATE INDEX audit_correlation_idx ON audit_events (correlation_id, sequence);
CREATE INDEX audit_email_idx       ON audit_events (email_id, created_at);
CREATE INDEX audit_entity_idx      ON audit_events (entity_type, entity_id);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
