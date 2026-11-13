-- asset-service: infrastructure asset register, categories, hierarchy, lifecycle.

CREATE TABLE asset_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL,
  code       text        NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  code                 text        NOT NULL,
  name                 text        NOT NULL,
  category_id          uuid        NOT NULL REFERENCES asset_categories (id),
  parent_id            uuid REFERENCES assets (id) ON DELETE RESTRICT,
  status               text        NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'active', 'under_maintenance', 'retired')),
  condition            text        NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'fair', 'poor', 'critical')),
  latitude             double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude            double precision CHECK (longitude BETWEEN -180 AND 180),
  attributes           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  commissioned_on      date,
  last_maintained_at   timestamptz,
  next_maintenance_due timestamptz,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX assets_status_idx ON assets (tenant_id, status);
CREATE INDEX assets_parent_idx ON assets (parent_id);
CREATE INDEX assets_category_idx ON assets (category_id);
-- Maintenance planning: what is due next.
CREATE INDEX assets_maintenance_idx ON assets (tenant_id, next_maintenance_due) WHERE status <> 'retired';

CREATE TABLE asset_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  asset_id    uuid        NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  from_status text,
  to_status   text        NOT NULL,
  changed_by  text        NOT NULL,
  note        text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_status_history_asset_idx ON asset_status_history (asset_id, changed_at);

ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_categories_isolation ON asset_categories USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY assets_isolation ON assets USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE asset_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_status_history_isolation ON asset_status_history USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
