-- TITAN v3: read models that are not specific to one industry. Forward-only; the six read
-- models of 0001 and their endpoints are unchanged.

CREATE TABLE kpi_incidents_by_category (
  tenant_id                  uuid   NOT NULL,
  category                   text   NOT NULL,
  severity                   text   NOT NULL,
  status                     text   NOT NULL,
  incidents                  bigint NOT NULL,
  avg_seconds_to_acknowledge double precision
);
CREATE INDEX kpi_incidents_by_category_tenant_idx ON kpi_incidents_by_category (tenant_id, category);

-- Any registered metric (vibration, temperature, water level, ...), not only water level.
CREATE TABLE kpi_metric_trend (
  tenant_id   uuid             NOT NULL,
  device_id   uuid             NOT NULL,
  device_name text,
  device_type text,
  sensor_kind text             NOT NULL,
  unit        text,
  bucket      timestamptz      NOT NULL,
  avg_value   double precision,
  min_value   double precision,
  max_value   double precision,
  samples     bigint           NOT NULL
);
CREATE INDEX kpi_metric_trend_series_idx ON kpi_metric_trend (tenant_id, sensor_kind, device_id, bucket);

CREATE TABLE kpi_maintenance_requests (
  tenant_id    uuid   NOT NULL,
  pack_id      text   NOT NULL,
  request_type text   NOT NULL,
  status       text   NOT NULL,
  priority     text,
  requests     bigint NOT NULL
);
CREATE INDEX kpi_maintenance_requests_tenant_idx ON kpi_maintenance_requests (tenant_id, pack_id);

CREATE TABLE kpi_maintenance_work_orders (
  tenant_id    uuid    NOT NULL,
  pack_id      text    NOT NULL,
  request_type text    NOT NULL,
  status       text    NOT NULL,
  priority     text,
  open         boolean NOT NULL,
  work_orders  bigint  NOT NULL
);
CREATE INDEX kpi_maintenance_work_orders_tenant_idx ON kpi_maintenance_work_orders (tenant_id, pack_id);

CREATE TABLE kpi_work_order_turnaround (
  tenant_id                       uuid   NOT NULL,
  pack_id                         text   NOT NULL,
  request_type                    text   NOT NULL,
  completed                       bigint NOT NULL,
  avg_request_to_completion_hours double precision,
  avg_repair_hours                double precision,
  avg_labor_hours                 double precision,
  last_completed_at               timestamptz
);
CREATE INDEX kpi_work_order_turnaround_tenant_idx ON kpi_work_order_turnaround (tenant_id, pack_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kpi_incidents_by_category', 'kpi_metric_trend', 'kpi_maintenance_requests',
                           'kpi_maintenance_work_orders', 'kpi_work_order_turnaround']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = app_tenant_id())', t || '_isolation', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM {{APP_ROLE}}', t);
  END LOOP;
END
$$;

-- The single write path now also accepts the new dataset names. Same behaviour otherwise:
-- only known names, atomic replacement, freshness recorded.
CREATE OR REPLACE FUNCTION analytics_load(dataset text, payload jsonb, run_id uuid, modified_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target regclass;
  loaded bigint;
BEGIN
  IF dataset NOT IN ('approval_turnaround', 'pending_tasks', 'incidents_by_severity',
                     'sensor_availability', 'water_level_trend', 'asset_maintenance_status',
                     'incidents_by_category', 'metric_trend', 'maintenance_requests',
                     'maintenance_work_orders', 'work_order_turnaround') THEN
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
