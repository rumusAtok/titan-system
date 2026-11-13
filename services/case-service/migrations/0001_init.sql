-- case-service: configurable forms, case records, lifecycle, attachments.

-- Master data: versioned form definitions.
CREATE TABLE form_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  key          text        NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version      integer     NOT NULL CHECK (version > 0),
  title        text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  workflow_key text        NOT NULL,
  fields       jsonb       NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);
-- At most one active version per form key.
CREATE UNIQUE INDEX form_definitions_active_idx ON form_definitions (tenant_id, key) WHERE active;

-- Per-tenant, per-year reference number counter.
CREATE TABLE case_counters (
  tenant_id uuid    NOT NULL,
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

-- Transactional data.
CREATE TABLE cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  reference_no       text        NOT NULL,
  form_id            uuid        NOT NULL REFERENCES form_definitions (id),
  form_key           text        NOT NULL,
  title              text        NOT NULL,
  channel            text        NOT NULL CHECK (channel IN ('public', 'internal')),
  applicant_id       text        NOT NULL,
  applicant_username text        NOT NULL,
  applicant_email    text,
  status             text        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected', 'cancelled')),
  current_stage      text,
  data               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Optimistic concurrency token, incremented on every change.
  version            integer     NOT NULL DEFAULT 1,
  submitted_at       timestamptz,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);
-- Review inbox / list screens: filter by status, newest first.
CREATE INDEX cases_status_idx ON cases (tenant_id, status, created_at DESC);
-- "My applications" for an applicant.
CREATE INDEX cases_applicant_idx ON cases (tenant_id, applicant_id, created_at DESC);

-- Historical state tracking: one row per lifecycle transition.
CREATE TABLE case_status_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  case_id         uuid        NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  from_status     text,
  to_status       text        NOT NULL,
  stage           text,
  actor_id        text,
  actor_username  text,
  note            text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_status_history_case_idx ON case_status_history (case_id, occurred_at);

-- Interim attachment store (bounded size) until document-service exists.
CREATE TABLE case_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  case_id      uuid        NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  filename     text        NOT NULL,
  content_type text        NOT NULL,
  size_bytes   integer     NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  sha256       text        NOT NULL,
  content      bytea       NOT NULL,
  uploaded_by  text        NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_attachments_case_idx ON case_attachments (case_id);

ALTER TABLE form_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY form_definitions_isolation ON form_definitions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE case_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY case_counters_isolation ON case_counters USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY cases_isolation ON cases USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE case_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY case_status_history_isolation ON case_status_history USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE case_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY case_attachments_isolation ON case_attachments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
