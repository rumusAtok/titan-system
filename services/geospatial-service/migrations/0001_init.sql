-- geospatial-service: zones (geofences) and a located-feature projection.
-- Geometry is GeoJSON in jsonb, evaluated in the service; bounding-box columns prefilter queries.

CREATE TABLE zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid             NOT NULL,
  code            text             NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name            text             NOT NULL,
  zone_type       text             NOT NULL CHECK (zone_type IN ('flood_zone', 'catchment', 'site_boundary', 'restricted_area', 'service_area', 'other')),
  description     text             NOT NULL DEFAULT '',
  geometry        jsonb            NOT NULL,
  min_lon         double precision NOT NULL,
  min_lat         double precision NOT NULL,
  max_lon         double precision NOT NULL,
  max_lat         double precision NOT NULL,
  area_m2         bigint           NOT NULL,
  -- Incidents located inside the zone are announced, and this role is told.
  watch_incidents boolean          NOT NULL DEFAULT false,
  notify_role     text,
  created_by      text             NOT NULL,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  version         integer          NOT NULL DEFAULT 1,
  updated_at      timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (min_lon <= max_lon AND min_lat <= max_lat)
);
CREATE INDEX zones_bbox_idx ON zones (tenant_id, min_lat, max_lat, min_lon, max_lon);

-- Everything with a position that other services announced: assets, devices, cameras.
CREATE TABLE located_features (
  feature_type text             NOT NULL CHECK (feature_type IN ('asset', 'device', 'camera')),
  feature_id   uuid             NOT NULL,
  tenant_id    uuid             NOT NULL,
  code         text             NOT NULL,
  name         text             NOT NULL,
  category     text,
  asset_id     uuid,
  latitude     double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_type, feature_id)
);
CREATE INDEX located_features_position_idx ON located_features (tenant_id, latitude, longitude);

-- Incidents placed on the map through their asset or device.
CREATE TABLE incident_locations (
  incident_id  uuid PRIMARY KEY,
  tenant_id    uuid             NOT NULL,
  reference_no text             NOT NULL,
  title        text             NOT NULL,
  severity     text             NOT NULL,
  located_via  text             NOT NULL CHECK (located_via IN ('asset', 'device')),
  latitude     double precision NOT NULL,
  longitude    double precision NOT NULL,
  zone_ids     uuid[]           NOT NULL DEFAULT '{}',
  created_at   timestamptz      NOT NULL
);
CREATE INDEX incident_locations_tenant_idx ON incident_locations (tenant_id, created_at DESC);

ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY zones_isolation ON zones USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE located_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY located_features_isolation ON located_features USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE incident_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_locations_isolation ON incident_locations USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
