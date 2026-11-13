-- alert-service: threshold rules, alarms, deduplication, escalation, acknowledgment.

CREATE TABLE alert_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid             NOT NULL,
  name            text             NOT NULL,
  sensor_kind     text             NOT NULL,
  -- NULL: the rule applies to every device that has this sensor.
  device_id       uuid,
  operator        text             NOT NULL CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
  threshold       double precision NOT NULL,
  -- Hysteresis: the alarm clears only once the value is back past this level.
  clear_threshold double precision,
  severity        text             NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  create_incident boolean          NOT NULL DEFAULT true,
  enabled         boolean          NOT NULL DEFAULT true,
  version         integer          NOT NULL DEFAULT 1,
  created_by      text             NOT NULL,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  updated_at      timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
-- Rule lookup for each incoming measurement.
CREATE INDEX alert_rules_match_idx ON alert_rules (tenant_id, sensor_kind) WHERE enabled;

CREATE TABLE alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('threshold', 'device_offline')),
  rule_id            uuid REFERENCES alert_rules (id) ON DELETE SET NULL,
  rule_name          text        NOT NULL,
  device_id          uuid        NOT NULL,
  device_name        text,
  sensor_kind        text,
  severity           text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'acknowledged', 'cleared')),
  operator           text,
  threshold          double precision,
  trigger_value      double precision,
  last_value         double precision,
  -- How many breaching readings were folded into this alarm.
  occurrences        integer     NOT NULL DEFAULT 1,
  first_triggered_at timestamptz NOT NULL,
  last_triggered_at  timestamptz NOT NULL,
  acknowledged_by    text,
  acknowledged_at    timestamptz,
  escalated_at       timestamptz,
  cleared_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Deduplication guarantee: at most one open alarm per rule (or per kind, for
-- rule-less alarms) and device, enforced by the database.
CREATE UNIQUE INDEX alerts_open_unique_idx
  ON alerts (tenant_id, device_id, kind, COALESCE(rule_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('active', 'acknowledged');
CREATE INDEX alerts_status_idx ON alerts (tenant_id, status, last_triggered_at DESC);
-- Escalation sweep.
CREATE INDEX alerts_unacknowledged_idx ON alerts (first_triggered_at) WHERE status = 'active' AND escalated_at IS NULL;

-- Device names for readable alarm titles (projection of device-service events).
CREATE TABLE device_names (
  device_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name      text NOT NULL
);

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_rules_isolation ON alert_rules USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_isolation ON alerts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE device_names ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_names_isolation ON device_names USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Cross-tenant lookup for the escalation sweep: ids only.
CREATE FUNCTION alerts_unacknowledged(older_than_seconds integer, max_rows integer)
  RETURNS TABLE (alert_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.id, a.tenant_id
    FROM alerts a
   WHERE a.status = 'active' AND a.escalated_at IS NULL
     AND a.severity IN ('warning', 'critical')
     AND a.first_triggered_at < now() - make_interval(secs => older_than_seconds)
   ORDER BY a.first_triggered_at
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION alerts_unacknowledged(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerts_unacknowledged(integer, integer) TO {{APP_ROLE}};
