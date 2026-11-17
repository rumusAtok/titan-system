-- TITAN v3: sensor profiles. A profile names a kind of device and the metrics it reports
-- (kind, unit, plausible range), so devices of any industry are registered consistently.
-- Profiles are installed by industry packs or created by an administrator. Forward-only.

CREATE TABLE sensor_profiles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid        NOT NULL,
  key                       text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  name                      text        NOT NULL,
  device_type               text        NOT NULL,
  expected_interval_seconds integer     NOT NULL DEFAULT 30 CHECK (expected_interval_seconds BETWEEN 1 AND 86400),
  -- [{ "kind", "label", "unit", "min_valid", "max_valid" }]
  sensors                   jsonb       NOT NULL,
  pack_id                   text,
  version                   integer     NOT NULL DEFAULT 1,
  created_by                text        NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

ALTER TABLE sensor_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY sensor_profiles_isolation ON sensor_profiles USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Profile a device was registered from (NULL for devices registered with explicit sensors, as before).
ALTER TABLE devices ADD COLUMN profile_key text;
CREATE INDEX devices_profile_idx ON devices (tenant_id, profile_key) WHERE profile_key IS NOT NULL;
CREATE INDEX devices_type_idx ON devices (tenant_id, device_type);
