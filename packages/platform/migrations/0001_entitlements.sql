-- Local projection of each tenant's entitlements (active capabilities and
-- industry packs). Present in every service-owned database.
--
-- tenant-service owns the truth and announces the complete state with
-- `tenant.entitlements.changed.v1`. Each service keeps its own copy so that
-- enforcing a capability never needs a call to another service, and keeps
-- working while tenant-service is down.
CREATE TABLE tenant_entitlements (
  tenant_id    uuid PRIMARY KEY,
  capabilities text[]      NOT NULL DEFAULT '{}',
  packs        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Only grows; a delivery with a lower or equal revision is ignored.
  revision     bigint      NOT NULL CHECK (revision > 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_entitlements_isolation ON tenant_entitlements
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
