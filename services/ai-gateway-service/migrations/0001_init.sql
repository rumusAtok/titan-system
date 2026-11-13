-- ai-gateway-service: approved reference documents, retrieval index, tool audit log,
-- proposed actions awaiting human approval, reviewable report drafts.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Knowledge sources. Only documents explicitly approved by a tenant
-- administrator are ever retrieved.
CREATE TABLE reference_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  title          text        NOT NULL,
  source         text        NOT NULL DEFAULT 'uploaded',
  classification text        NOT NULL DEFAULT 'internal' CHECK (classification IN ('public', 'internal', 'restricted')),
  -- Empty: visible to all staff of the tenant. Otherwise only to holders of one of these roles.
  allowed_roles  text[]      NOT NULL DEFAULT '{}',
  status         text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'retired')),
  content        text        NOT NULL,
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, title)
);

CREATE TABLE document_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid    NOT NULL,
  document_id     uuid    NOT NULL REFERENCES reference_documents (id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  content         text    NOT NULL,
  -- Set when the text matches a prompt-injection pattern; such chunks are never given to a model.
  flagged         boolean NOT NULL DEFAULT false,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  -- NULL until an embedding model is available (lexical search works without it).
  embedding       vector(768),
  embedding_model text,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- Audit log of every tool invocation made on behalf of a user.
CREATE TABLE tool_executions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  user_id        text        NOT NULL,
  username       text        NOT NULL,
  use_case       text        NOT NULL,
  tool           text        NOT NULL,
  arguments      jsonb       NOT NULL,
  status         text        NOT NULL CHECK (status IN ('ok', 'denied', 'error', 'timeout', 'rejected')),
  detail         text,
  duration_ms    integer     NOT NULL,
  selected_by    text        NOT NULL CHECK (selected_by IN ('model', 'rules', 'endpoint')),
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_executions_time_idx ON tool_executions (tenant_id, created_at DESC);

-- A write the assistant suggested. Nothing here is executed until a person
-- approves it, and then it runs with that person's own permissions.
CREATE TABLE pending_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('incident.add_note')),
  arguments     jsonb       NOT NULL,
  rationale     text        NOT NULL,
  proposed_for  text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'rejected', 'failed', 'expired')),
  decided_by    text,
  decided_at    timestamptz,
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX pending_actions_status_idx ON pending_actions (tenant_id, status, created_at DESC);

CREATE TABLE report_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  report_type   text        NOT NULL,
  title         text        NOT NULL,
  body          text        NOT NULL,
  sources       jsonb       NOT NULL,
  generated_by  text        NOT NULL,
  model         text,
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  requested_by  text        NOT NULL,
  reviewed_by   text,
  review_note   text,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_drafts_time_idx ON report_drafts (tenant_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reference_documents', 'document_chunks', 'tool_executions', 'pending_actions', 'report_drafts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END
$$;

-- The tool audit log is append-only for the service.
REVOKE UPDATE, DELETE, TRUNCATE ON tool_executions FROM {{APP_ROLE}};
