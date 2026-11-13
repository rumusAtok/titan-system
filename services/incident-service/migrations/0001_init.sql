-- incident-service: incident lifecycle, severity, assignment, acknowledgment, response, closure.

CREATE TABLE incident_counters (
  tenant_id uuid    NOT NULL,
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  reference_no      text        NOT NULL,
  title             text        NOT NULL,
  description       text        NOT NULL DEFAULT '',
  severity          text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'closed')),
  source_type       text        NOT NULL CHECK (source_type IN ('alert', 'manual')),
  -- Id of the originating alarm, when raised automatically.
  source_id         text,
  device_id         uuid,
  assignee_id       text,
  assignee_username text,
  acknowledged_by   text,
  acknowledged_at   timestamptz,
  resolved_by       text,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);
-- Deduplication guarantee: one incident per originating alarm, enforced by
-- the database regardless of how many times the alarm event is delivered.
CREATE UNIQUE INDEX incidents_source_unique_idx ON incidents (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX incidents_status_idx ON incidents (tenant_id, status, created_at DESC);
CREATE INDEX incidents_severity_idx ON incidents (tenant_id, severity, created_at DESC);

CREATE TABLE incident_timeline (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  incident_id    uuid        NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  entry_type     text        NOT NULL,
  message        text        NOT NULL,
  actor_id       text,
  actor_username text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_timeline_incident_idx ON incident_timeline (incident_id, occurred_at);

ALTER TABLE incident_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_counters_isolation ON incident_counters USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY incidents_isolation ON incidents USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE incident_timeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_timeline_isolation ON incident_timeline USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
