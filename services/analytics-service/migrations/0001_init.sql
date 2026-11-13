-- analytics-service: analytical read models (loaded from the gold layer) and load metadata.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE kpi_approval_turnaround (
  tenant_id          uuid   NOT NULL,
  form_key           text,
  outcome            text   NOT NULL,
  cases              bigint NOT NULL,
  avg_hours          double precision,
  median_hours       double precision,
  p90_hours          double precision,
  first_submitted_at timestamptz,
  last_completed_at  timestamptz
);
CREATE INDEX kpi_approval_turnaround_tenant_idx ON kpi_approval_turnaround (tenant_id);

CREATE TABLE kpi_pending_tasks (
  tenant_id          uuid   NOT NULL,
  subject_type       text,
  stage_key          text,
  role               text,
  pending            bigint NOT NULL,
  overdue            bigint NOT NULL,
  oldest_assigned_at timestamptz,
  oldest_age_hours   double precision
);
CREATE INDEX kpi_pending_tasks_tenant_idx ON kpi_pending_tasks (tenant_id);

CREATE TABLE kpi_incidents_by_severity (
  tenant_id                  uuid   NOT NULL,
  severity                   text   NOT NULL,
  status                     text   NOT NULL,
  incidents                  bigint NOT NULL,
  avg_seconds_to_acknowledge double precision
);
CREATE INDEX kpi_incidents_by_severity_tenant_idx ON kpi_incidents_by_severity (tenant_id);

CREATE TABLE kpi_sensor_availability (
  tenant_id                 uuid   NOT NULL,
  device_id                 uuid   NOT NULL,
  serial_no                 text,
  name                      text,
  status                    text,
  expected_interval_seconds bigint,
  messages_last_hour        bigint NOT NULL,
  expected_last_hour        bigint,
  availability_pct          double precision,
  last_observed_at          timestamptz
);
CREATE INDEX kpi_sensor_availability_tenant_idx ON kpi_sensor_availability (tenant_id);

CREATE TABLE kpi_water_level_trend (
  tenant_id uuid             NOT NULL,
  device_id uuid             NOT NULL,
  bucket    timestamptz      NOT NULL,
  avg_level double precision,
  min_level double precision,
  max_level double precision,
  samples   bigint           NOT NULL
);
-- Chart queries: one device over time.
CREATE INDEX kpi_water_level_trend_series_idx ON kpi_water_level_trend (tenant_id, device_id, bucket);

CREATE TABLE kpi_asset_maintenance_status (
  tenant_id           uuid   NOT NULL,
  status              text   NOT NULL,
  condition           text,
  assets              bigint NOT NULL,
  maintenance_overdue bigint NOT NULL,
  due_within_30_days  bigint NOT NULL
);
CREATE INDEX kpi_asset_maintenance_status_tenant_idx ON kpi_asset_maintenance_status (tenant_id);

-- Freshness and provenance of each read model (no tenant data).
CREATE TABLE dataset_loads (
  dataset            text PRIMARY KEY,
  source_run_id      uuid,
  source_modified_at timestamptz NOT NULL,
  row_count          bigint      NOT NULL,
  loaded_at          timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kpi_approval_turnaround', 'kpi_pending_tasks', 'kpi_incidents_by_severity',
                           'kpi_sensor_availability', 'kpi_water_level_trend', 'kpi_asset_maintenance_status']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Read-only policy: the tables are written only by analytics_load() below.
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = app_tenant_id())', t || '_isolation', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM {{APP_ROLE}}', t);
  END LOOP;
END
$$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON dataset_loads FROM {{APP_ROLE}};

-- Loading a gold dataset replaces the rows of ALL tenants at once, so it
-- cannot run under a tenant's row-level security. This function is the single
-- write path: it accepts only known dataset names and replaces the read model
-- atomically (readers see the old or the new version, never a mix).
CREATE FUNCTION analytics_load(dataset text, payload jsonb, run_id uuid, modified_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target regclass;
  loaded bigint;
BEGIN
  IF dataset NOT IN ('approval_turnaround', 'pending_tasks', 'incidents_by_severity',
                     'sensor_availability', 'water_level_trend', 'asset_maintenance_status') THEN
    RAISE EXCEPTION 'unknown dataset %', dataset USING ERRCODE = 'invalid_parameter_value';
  END IF;
  target := ('kpi_' || dataset)::regclass;
  EXECUTE format('DELETE FROM %s', target);
  EXECUTE format('INSERT INTO %s SELECT * FROM jsonb_populate_recordset(NULL::%s, $1)', target, target) USING payload;
  GET DIAGNOSTICS loaded = ROW_COUNT;
  INSERT INTO dataset_loads (dataset, source_run_id, source_modified_at, row_count, loaded_at)
  VALUES (dataset, run_id, modified_at, loaded, now())
  ON CONFLICT ON CONSTRAINT dataset_loads_pkey DO UPDATE
    SET source_run_id = COALESCE(EXCLUDED.source_run_id, dataset_loads.source_run_id),
        source_modified_at = EXCLUDED.source_modified_at, row_count = EXCLUDED.row_count, loaded_at = now();
  RETURN loaded;
END
$$;
REVOKE ALL ON FUNCTION analytics_load(text, jsonb, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_load(text, jsonb, uuid, timestamptz) TO {{APP_ROLE}};
