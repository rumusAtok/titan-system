-- report-service: report definitions over registered analytics datasets, and generated runs.
-- Data is read from analytics-service at generation time with the requesting user's token,
-- so a report never shows a user more than the analytics API would.

CREATE TABLE report_definitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- [{ "title": "...", "dataset": "incidents_by_severity", "filters": {...}, "limit": 500 }]
  sections         jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array'),
  schedule         text NOT NULL DEFAULT 'none' CHECK (schedule IN ('none', 'daily', 'weekly', 'monthly')),
  next_due_at      timestamptz,
  -- Role reminded when a scheduled report falls due (in addition to the owner).
  notify_role      text,
  owner_id         text NOT NULL,
  owner_username   text NOT NULL,
  pack_id          text,
  active           boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX report_definitions_due_idx ON report_definitions (next_due_at) WHERE active AND next_due_at IS NOT NULL;

CREATE TABLE report_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  definition_id    uuid NOT NULL REFERENCES report_definitions (id),
  definition_name  text NOT NULL,
  status           text NOT NULL CHECK (status IN ('completed', 'failed')),
  -- [{ title, dataset, columns, rows, freshness }] as returned by the analytics API.
  result           jsonb,
  total_rows       integer NOT NULL DEFAULT 0,
  error            text,
  generated_by     text NOT NULL,
  generated_by_id  text NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_runs_definition_idx ON report_runs (tenant_id, definition_id, generated_at DESC);

ALTER TABLE report_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_definitions_isolation ON report_definitions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_runs_isolation ON report_runs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Cross-tenant lookup for the schedule sweep: ids only.
CREATE FUNCTION report_definitions_due(max_rows integer)
  RETURNS TABLE (definition_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.id, d.tenant_id FROM report_definitions d
   WHERE d.active AND d.next_due_at IS NOT NULL AND d.next_due_at <= now()
   ORDER BY d.next_due_at
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION report_definitions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_definitions_due(integer) TO {{APP_ROLE}};
