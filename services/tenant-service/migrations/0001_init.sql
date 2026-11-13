-- tenant-service: organisations, departments, jurisdictions, memberships.

CREATE TABLE tenants (
  id           uuid PRIMARY KEY,
  slug         text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_config (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  settings     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version      integer     NOT NULL DEFAULT 1,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code         text        NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
  name         text        NOT NULL,
  parent_id    uuid REFERENCES departments (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX departments_parent_idx ON departments (parent_id);

CREATE TABLE jurisdictions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code         text        NOT NULL,
  name         text        NOT NULL,
  level        text        NOT NULL DEFAULT 'district',
  parent_id    uuid REFERENCES jurisdictions (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Organisational membership. Authentication and role assignment live in
-- Keycloak; this records where a user sits in the organisation.
CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id       text        NOT NULL,
  username      text        NOT NULL,
  department_id uuid REFERENCES departments (id) ON DELETE SET NULL,
  title         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_department_idx ON memberships (department_id);

-- Row-level security -------------------------------------------------------
-- A tenant row is visible to its own tenant; the platform tenant (asserted by
-- the identity provider for platform administrators only) sees all tenants.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants
  USING (id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE tenant_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_config_isolation ON tenant_config
  USING (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (tenant_id = app_tenant_id() OR app_tenant_id() = '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY departments_isolation ON departments
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE jurisdictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY jurisdictions_isolation ON jurisdictions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation ON memberships
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
