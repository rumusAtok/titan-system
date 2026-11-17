-- TITAN v3: versioned attribute schemas per asset category, categories installed by industry packs,
-- and a reference from an asset to its site. Forward-only; existing assets are not modified.

ALTER TABLE asset_categories ADD COLUMN description text NOT NULL DEFAULT '';
-- Pack the category belongs to (NULL: created by a person).
ALTER TABLE asset_categories ADD COLUMN pack_id text;

-- What attributes an asset of a category has. A new version supersedes the previous one for
-- assets created or edited afterwards; assets record the version they were last validated against.
CREATE TABLE asset_attribute_schemas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  category_id uuid        NOT NULL REFERENCES asset_categories (id) ON DELETE CASCADE,
  version     integer     NOT NULL CHECK (version > 0),
  fields      jsonb       NOT NULL,
  active      boolean     NOT NULL DEFAULT false,
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, version)
);
-- At most one schema version in force per category.
CREATE UNIQUE INDEX asset_attribute_schemas_active_idx ON asset_attribute_schemas (category_id) WHERE active;

ALTER TABLE asset_attribute_schemas ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_attribute_schemas_isolation ON asset_attribute_schemas USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- NULL: the asset's attributes were never validated against a schema (its category had none).
ALTER TABLE assets ADD COLUMN attribute_schema_version integer;
-- Logical reference to a site of tenant-service (plant, building, line).
ALTER TABLE assets ADD COLUMN site_id uuid;
CREATE INDEX assets_site_idx ON assets (tenant_id, site_id) WHERE site_id IS NOT NULL;
