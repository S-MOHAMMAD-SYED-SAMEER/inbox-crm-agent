-- 002_crm.sql
-- The local CRM (spec §10, FR-34..FR-37).
--
-- SPEC RECONCILIATION — `deleted_at`
-- Spec §10 does not list a deleted_at column, but §11 specifies that DELETE is
-- soft ("sets deleted_at, filtered from reads") and always human-initiated.
-- The two sections disagree; §11 describes the behaviour the product needs, so
-- deleted_at is added here to every CRM table. It is a column, not a new
-- entity, and it changes no other part of the design.
--
-- The unique indexes are partial on `deleted_at IS NULL` as a direct
-- consequence: without that, soft-deleting a contact would permanently block
-- ever re-creating one with the same address, which is exactly the kind of
-- dead-end a "soft" delete is supposed to avoid.

CREATE TABLE companies (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  name_norm    TEXT NOT NULL,
  domain       TEXT,
  website      TEXT,
  industry     TEXT,
  size_band    TEXT,
  country      TEXT,
  source       TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX companies_domain_idx ON companies (domain)
  WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX companies_name_norm_idx ON companies (name_norm);

CREATE TABLE contacts (
  id            UUID PRIMARY KEY,
  company_id    UUID REFERENCES companies(id) ON DELETE SET NULL,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  job_title     TEXT,
  lifecycle     TEXT NOT NULL DEFAULT 'lead'
                  CHECK (lifecycle IN ('lead','qualified','customer','partner','vendor','other')),
  source        TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX contacts_email_idx ON contacts (lower(email))
  WHERE deleted_at IS NULL;
CREATE INDEX contacts_company_idx ON contacts (company_id);

CREATE TABLE deals (
  id                  UUID PRIMARY KEY,
  company_id          UUID REFERENCES companies(id) ON DELETE SET NULL,
  primary_contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  stage               TEXT NOT NULL DEFAULT 'new_lead'
                        CHECK (stage IN ('new_lead','qualifying','proposal',
                                         'negotiation','won','lost')),
  service_line        TEXT CHECK (service_line IN ('ai_customer_support','website_modernization',
                                                   'workflow_automation','ai_recruitment',
                                                   'inbox_lead_management','other')),
  amount_minor        BIGINT,
  currency            TEXT NOT NULL DEFAULT 'USD',
  requirement_summary TEXT,
  budget_note         TEXT,
  timeline_note       TEXT,
  expected_close_date DATE,
  source              TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX deals_stage_idx   ON deals (stage, updated_at DESC);
CREATE INDEX deals_company_idx ON deals (company_id);

CREATE TABLE tasks (
  id           UUID PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  due_at       TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  assignee     TEXT,
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id   UUID REFERENCES companies(id) ON DELETE SET NULL,
  deal_id      UUID REFERENCES deals(id) ON DELETE SET NULL,
  email_id     UUID REFERENCES emails(id) ON DELETE SET NULL,
  source       TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX tasks_open_due_idx ON tasks (status, due_at);

CREATE TABLE activities (
  id           UUID PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('email_in','email_out','note','stage_change',
                                             'task_created','call','meeting')),
  direction    TEXT CHECK (direction IN ('inbound','outbound')),
  subject      TEXT,
  body         TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id   UUID REFERENCES companies(id) ON DELETE SET NULL,
  deal_id      UUID REFERENCES deals(id) ON DELETE SET NULL,
  email_id     UUID REFERENCES emails(id) ON DELETE SET NULL,
  source       TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX activities_timeline_idx ON activities (contact_id, occurred_at DESC);
CREATE INDEX activities_company_idx  ON activities (company_id, occurred_at DESC);
CREATE INDEX activities_deal_idx     ON activities (deal_id, occurred_at DESC);

CREATE TABLE notes (
  id           UUID PRIMARY KEY,
  body         TEXT NOT NULL,
  author       TEXT NOT NULL,
  contact_id   UUID REFERENCES contacts(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  deal_id      UUID REFERENCES deals(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('agent','human','seed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX notes_contact_idx ON notes (contact_id, created_at DESC);
CREATE INDEX notes_company_idx ON notes (company_id, created_at DESC);
CREATE INDEX notes_deal_idx    ON notes (deal_id, created_at DESC);
