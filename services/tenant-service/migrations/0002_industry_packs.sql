-- TITAN v3: industry-pack registry, tenant activation, entitlements, sites, dashboard layouts.
-- Forward-only; nothing created by 0001 is changed.

-- Catalogue of pack versions shipped with the platform. Not tenant data.
-- A published (pack_id, version) is immutable: the application role may add
-- versions but can never change or remove one.
CREATE TABLE pack_catalog (
  pack_id       text        NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  version       text        NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  name          text        NOT NULL,
  industry      text        NOT NULL,
  manifest      jsonb       NOT NULL,
  checksum      text        NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version)
);
REVOKE UPDATE, DELETE, TRUNCATE ON pack_catalog FROM {{APP_ROLE}};

-- Which packs a tenant uses. Deactivating a pack keeps the row (and every
-- business record anywhere on the platform): only `status` changes.
CREATE TABLE tenant_packs (
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pack_id      text        NOT NULL,
  version      text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('active', 'disabled')),
  -- The tenant's own values; defaults come from the manifest.
  config       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_version  integer     NOT NULL DEFAULT 1,
  activated_by text        NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  disabled_by  text,
  disabled_at  timestamptz,
  -- true while the activation still has to be announced to the other services.
  sync_pending boolean     NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_id)
);
CREATE INDEX tenant_packs_sync_idx ON tenant_packs (tenant_id) WHERE sync_pending;

-- Append-only record of every change to a tenant's packs.
CREATE TABLE tenant_pack_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pack_id      text        NOT NULL,
  action       text        NOT NULL CHECK (action IN ('activated', 'reactivated', 'upgraded', 'downgraded', 'reconfigured', 'deactivated', 'resync')),
  from_version text,
  to_version   text,
  config       jsonb,
  actor        text        NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_pack_history_idx ON tenant_pack_history (tenant_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON tenant_pack_history FROM {{APP_ROLE}};

-- Monotonic revision of a tenant's entitlements, carried by tenant.entitlements.changed.v1.
CREATE TABLE tenant_entitlement_revisions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  revision  bigint NOT NULL DEFAULT 0
);

-- Organisation structure below the tenant: business units, plants, facilities, buildings, lines.
CREATE TABLE sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code       text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name       text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('business_unit', 'plant', 'facility', 'campus', 'building', 'line', 'area', 'site')),
  parent_id  uuid REFERENCES sites (id) ON DELETE RESTRICT,
  address    text,
  latitude   double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude  double precision CHECK (longitude BETWEEN -180 AND 180),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX sites_parent_idx ON sites (parent_id);

-- A tenant's own arrangement of a dashboard: which of its widgets are shown, in which order.
CREATE TABLE dashboard_layouts (
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  dashboard_key text        NOT NULL,
  widgets       jsonb       NOT NULL,
  version       integer     NOT NULL DEFAULT 1,
  updated_by    text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dashboard_key)
);

-- Row-level security. As for `tenants`, the platform tenant (platform
-- administrators and this service's own start-up work) sees every tenant's
-- pack rows; an ordinary tenant only its own.
ALTER TABLE tenant_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_packs_isolation ON tenant_packs
  USING (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE tenant_pack_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_pack_history_isolation ON tenant_pack_history
  USING (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE tenant_entitlement_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_entitlement_revisions_isolation ON tenant_entitlement_revisions
  USING (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY sites_isolation ON sites USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE dashboard_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboard_layouts_isolation ON dashboard_layouts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Upgrade of an existing installation: every tenant that exists now was using
-- the government and flood-monitoring functionality of TITAN v2. Give each of
-- them the platform core and the two packs that now carry that functionality,
-- so nothing they could do before is switched off. The service announces
-- these activations when it next starts (sync_pending).
INSERT INTO tenant_packs (tenant_id, pack_id, version, status, activated_by, sync_pending)
SELECT t.id, p.pack_id, '1.0.0', 'active', 'migration:0002_industry_packs', true
  FROM tenants t
 CROSS JOIN (VALUES ('platform-core'), ('public-services'), ('disaster-infrastructure')) AS p (pack_id);

INSERT INTO tenant_pack_history (tenant_id, pack_id, action, from_version, to_version, actor)
SELECT tenant_id, pack_id, 'activated', NULL, version, activated_by FROM tenant_packs;
