-- device-service: IoT device registry, sensor definitions, status and configuration.

CREATE TABLE devices (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid        NOT NULL,
  serial_no                 text        NOT NULL,
  name                      text        NOT NULL,
  device_type               text        NOT NULL,
  -- Logical reference to asset-service (no cross-database foreign key).
  asset_id                  uuid,
  latitude                  double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude                 double precision CHECK (longitude BETWEEN -180 AND 180),
  status                    text        NOT NULL DEFAULT 'registered'
                            CHECK (status IN ('registered', 'online', 'offline', 'decommissioned')),
  -- How often the device is expected to report; drives offline detection.
  expected_interval_seconds integer     NOT NULL DEFAULT 30 CHECK (expected_interval_seconds BETWEEN 1 AND 86400),
  config                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at              timestamptz,
  version                   integer     NOT NULL DEFAULT 1,
  registered_at             timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_no),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX devices_status_idx ON devices (tenant_id, status);
-- Offline sweep.
CREATE INDEX devices_online_seen_idx ON devices (last_seen_at) WHERE status = 'online';

CREATE TABLE sensors (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind      text NOT NULL,
  unit      text NOT NULL,
  -- Plausible physical range; readings outside it are flagged out_of_range.
  min_valid double precision,
  max_valid double precision,
  UNIQUE (device_id, kind),
  CHECK (min_valid IS NULL OR max_valid IS NULL OR min_valid < max_valid)
);

CREATE TABLE device_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  device_id   uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  from_status text,
  to_status   text        NOT NULL,
  reason      text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_status_history_device_idx ON device_status_history (device_id, changed_at DESC);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY devices_isolation ON devices USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE sensors ENABLE ROW LEVEL SECURITY;
CREATE POLICY sensors_isolation ON sensors USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE device_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_status_history_isolation ON device_status_history USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Offline detection has to look at devices of every tenant. This function is
-- the only cross-tenant operation the application role can perform here: it
-- marks silent devices offline and reports which ones changed.
-- A device is silent after 3 missed reporting intervals (at least `min_silence_seconds`).
CREATE FUNCTION devices_mark_offline(min_silence_seconds integer)
  RETURNS TABLE (device_id uuid, tenant_id uuid, serial_no text, name text, last_seen_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH silent AS (
    UPDATE devices d
       SET status = 'offline', version = d.version + 1, updated_at = now()
     WHERE d.status = 'online'
       AND d.last_seen_at < now() - make_interval(secs => GREATEST(d.expected_interval_seconds * 3, min_silence_seconds))
    RETURNING d.id, d.tenant_id, d.serial_no, d.name, d.last_seen_at
  ), logged AS (
    INSERT INTO device_status_history (tenant_id, device_id, from_status, to_status, reason)
    SELECT s.tenant_id, s.id, 'online', 'offline', 'no telemetry received within the expected interval' FROM silent s
  )
  SELECT s.id, s.tenant_id, s.serial_no, s.name, s.last_seen_at FROM silent s;
END
$$;
REVOKE ALL ON FUNCTION devices_mark_offline(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devices_mark_offline(integer) TO {{APP_ROLE}};
