-- telemetry-service: measurement ingestion, validation, time-series persistence.

-- Local projection of devices, built from device-service events. Telemetry
-- validation never calls device-service or reads its database.
CREATE TABLE device_projection (
  device_id  uuid PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  serial_no  text        NOT NULL,
  name       text        NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  -- [{kind, unit, min_valid, max_valid}]
  sensors    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Time series, range-partitioned by month on the observation time.
--   observed_at  when the sensor took the reading (device clock)
--   received_at  when the platform received the message
--   processed_at when the row was validated and stored
CREATE TABLE measurements (
  tenant_id    uuid             NOT NULL,
  device_id    uuid             NOT NULL,
  sensor_kind  text             NOT NULL,
  value        double precision NOT NULL,
  unit         text             NOT NULL,
  quality      text             NOT NULL CHECK (quality IN ('ok', 'out_of_range', 'late', 'future_timestamp')),
  message_id   text             NOT NULL,
  observed_at  timestamptz      NOT NULL,
  received_at  timestamptz      NOT NULL,
  processed_at timestamptz      NOT NULL DEFAULT now(),
  -- Natural key of a reading: redelivered messages collide here and are dropped.
  PRIMARY KEY (device_id, sensor_kind, observed_at, message_id)
) PARTITION BY RANGE (observed_at);

-- Charts and range queries: one device/sensor over time, newest first.
CREATE INDEX measurements_series_idx ON measurements (tenant_id, device_id, sensor_kind, observed_at DESC);

-- Readings whose timestamp falls outside every monthly partition still land somewhere.
CREATE TABLE measurements_default PARTITION OF measurements DEFAULT;

ALTER TABLE measurements ENABLE ROW LEVEL SECURITY;
CREATE POLICY measurements_isolation ON measurements USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Row-level security is defined on the parent. Partitions must therefore not
-- be reachable directly by the application role.
REVOKE ALL ON measurements_default FROM {{APP_ROLE}};

-- Creates the monthly partitions covering [now - months_back, now + months_ahead].
CREATE FUNCTION ensure_measurement_partitions(months_back integer, months_ahead integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  month_start date;
  part_name   text;
  created     integer := 0;
BEGIN
  FOR i IN -months_back..months_ahead LOOP
    month_start := (date_trunc('month', now()) + make_interval(months => i))::date;
    part_name := 'measurements_' || to_char(month_start, 'YYYY_MM');
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF measurements FOR VALUES FROM (%L) TO (%L)',
                     part_name, month_start, (month_start + interval '1 month')::date);
      EXECUTE format('REVOKE ALL ON %I FROM {{APP_ROLE}}', part_name);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

-- Retention: drops whole monthly partitions older than the retention window.
-- Dropping a partition is immediate and leaves no bloat, unlike DELETE.
CREATE FUNCTION drop_expired_measurement_partitions(retain_months integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  part    record;
  cutoff  date := (date_trunc('month', now()) - make_interval(months => retain_months))::date;
  dropped integer := 0;
BEGIN
  IF retain_months < 1 THEN
    RAISE EXCEPTION 'retain_months must be at least 1';
  END IF;
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'measurements' AND c.relname ~ '^measurements_\d{4}_\d{2}$'
  LOOP
    IF to_date(substring(part.relname from '\d{4}_\d{2}$'), 'YYYY_MM') < cutoff THEN
      EXECUTE format('DROP TABLE %I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;

REVOKE ALL ON FUNCTION ensure_measurement_partitions(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION drop_expired_measurement_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_measurement_partitions(integer, integer) TO {{APP_ROLE}};
GRANT EXECUTE ON FUNCTION drop_expired_measurement_partitions(integer) TO {{APP_ROLE}};

SELECT ensure_measurement_partitions(1, 2);

-- Latest value per device and sensor, for live tiles (avoids scanning the series).
CREATE TABLE latest_measurements (
  device_id   uuid             NOT NULL,
  sensor_kind text             NOT NULL,
  tenant_id   uuid             NOT NULL,
  value       double precision NOT NULL,
  unit        text             NOT NULL,
  quality     text             NOT NULL,
  observed_at timestamptz      NOT NULL,
  received_at timestamptz      NOT NULL,
  PRIMARY KEY (device_id, sensor_kind)
);

-- Messages that could not be accepted, kept for diagnosis.
CREATE TABLE rejected_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  device_id   text,
  topic       text        NOT NULL,
  reason      text        NOT NULL,
  detail      text,
  payload     text        NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rejected_messages_time_idx ON rejected_messages (tenant_id, received_at DESC);

ALTER TABLE device_projection ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_projection_isolation ON device_projection USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE latest_measurements ENABLE ROW LEVEL SECURITY;
CREATE POLICY latest_measurements_isolation ON latest_measurements USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE rejected_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rejected_messages_isolation ON rejected_messages USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
