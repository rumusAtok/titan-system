-- TITAN v3: incident categories, typed origins and business references.
-- Forward-only. Existing incidents keep their values and get the category 'general'.

-- Origins beyond alarms and manual reports. Every existing row ('alert', 'manual') satisfies the wider list.
ALTER TABLE incidents DROP CONSTRAINT incidents_source_type_check;
ALTER TABLE incidents
  ADD CONSTRAINT incidents_source_type_check
  CHECK (source_type IN ('alert', 'manual', 'inspection', 'work_order', 'service_request', 'external'));

ALTER TABLE incidents ADD COLUMN category text NOT NULL DEFAULT 'general';
-- Typed business references (logical: the records live in other services' databases).
ALTER TABLE incidents ADD COLUMN asset_id uuid;
ALTER TABLE incidents ADD COLUMN site_id uuid;
CREATE INDEX incidents_category_idx ON incidents (tenant_id, category, created_at DESC);
CREATE INDEX incidents_asset_idx ON incidents (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

-- Per-tenant incident categories, installed by industry packs (or created by an administrator).
-- A category decides the response process, who is told, and the response target per severity.
CREATE TABLE incident_categories (
  tenant_id        uuid        NOT NULL,
  key              text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  name             text        NOT NULL,
  description      text        NOT NULL DEFAULT '',
  workflow_key     text        NOT NULL DEFAULT 'incident-response',
  notify_role      text        NOT NULL DEFAULT 'duty_officer',
  -- {"critical": 15, "warning": 60}: minutes within which an incident of that severity should be acknowledged.
  response_targets jsonb       NOT NULL DEFAULT '{}'::jsonb,
  pack_id          text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE incident_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_categories_isolation ON incident_categories USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
