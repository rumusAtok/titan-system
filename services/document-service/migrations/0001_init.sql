-- document-service: controlled documents, versions, review, retention, legal hold, links to records.

CREATE TABLE document_counters (
  tenant_id uuid    NOT NULL,
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  reference_no       text        NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  document_type      text        NOT NULL CHECK (document_type IN ('procedure', 'drawing', 'certificate', 'inspection_report', 'contract', 'manual', 'record', 'other')),
  classification     text        NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
  -- For `restricted` documents: the roles that may read them (records managers and tenant administrators always may).
  allowed_roles      text[]      NOT NULL DEFAULT '{}',
  retention_class    text        NOT NULL,
  -- A new version must pass the `document-review` workflow before it is published.
  requires_review    boolean     NOT NULL DEFAULT true,
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  current_version_id uuid,
  legal_hold         boolean     NOT NULL DEFAULT false,
  legal_hold_reason  text,
  -- Earliest date the document may be disposed of (from its retention class; NULL = permanent).
  retain_until       date,
  created_by         text        NOT NULL,
  created_by_id      text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  disposed_at        timestamptz,
  disposed_by        text,
  version            integer     NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX documents_type_idx ON documents (tenant_id, document_type, created_at DESC);

CREATE TABLE document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  document_id  uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version      integer     NOT NULL CHECK (version > 0),
  filename     text        NOT NULL,
  content_type text        NOT NULL,
  size_bytes   integer     NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 5242880),
  sha256       text        NOT NULL,
  -- NULL once the document has been disposed of: metadata is kept as the record of disposal.
  content      bytea,
  status       text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'rejected', 'superseded', 'disposed')),
  change_note  text        NOT NULL DEFAULT '',
  scan_result  text        NOT NULL,
  uploaded_by  text        NOT NULL,
  uploaded_by_id text      NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (document_id, version)
);
-- At most one version of a document in review at a time.
CREATE UNIQUE INDEX document_versions_review_idx ON document_versions (document_id) WHERE status = 'in_review';

-- Logical links to records owned by other services (no cross-database keys).
CREATE TABLE document_links (
  tenant_id    uuid        NOT NULL,
  document_id  uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  subject_type text        NOT NULL CHECK (subject_type IN ('asset', 'incident', 'case', 'work_order', 'maintenance_request', 'purchase_order', 'site', 'camera')),
  subject_id   text        NOT NULL,
  linked_by    text        NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, subject_type, subject_id)
);
CREATE INDEX document_links_subject_idx ON document_links (tenant_id, subject_type, subject_id);

-- Append-only record of what happened to each document (alongside the platform audit trail).
CREATE TABLE document_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  entry_type  text        NOT NULL,
  message     text        NOT NULL,
  actor       text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_events_idx ON document_events (document_id, occurred_at);
REVOKE UPDATE, DELETE, TRUNCATE ON document_events FROM {{APP_ROLE}};

ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_counters_isolation ON document_counters USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_isolation ON documents USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_versions_isolation ON document_versions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE document_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_links_isolation ON document_links USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE document_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_events_isolation ON document_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
