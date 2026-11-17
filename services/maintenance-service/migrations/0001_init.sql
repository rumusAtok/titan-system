-- maintenance-service: request types, maintenance and service requests, work orders.

-- Kinds of request a tenant can raise. Installed by industry packs: each names the
-- approval workflow its requests go through and who may raise them.
CREATE TABLE request_types (
  tenant_id                   uuid        NOT NULL,
  key                         text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  name                        text        NOT NULL,
  description                 text        NOT NULL DEFAULT '',
  subject_type                text        NOT NULL CHECK (subject_type IN ('maintenance_request', 'service_request')),
  workflow_key                text        NOT NULL,
  default_priority            text        NOT NULL CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  requester_roles             text[]      NOT NULL,
  -- An incident of this category raises a request of this type automatically.
  auto_from_incident_category text,
  detail_fields               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pack_id                     text        NOT NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE maintenance_counters (
  tenant_id uuid    NOT NULL,
  series    text    NOT NULL CHECK (series IN ('MR', 'WO')),
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, series, year)
);

CREATE TABLE maintenance_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL,
  reference_no          text        NOT NULL,
  request_type          text        NOT NULL,
  -- Pack the request type belongs to: keeps the records of different industries apart in one tenant.
  pack_id               text        NOT NULL,
  subject_type          text        NOT NULL CHECK (subject_type IN ('maintenance_request', 'service_request')),
  workflow_key          text        NOT NULL,
  title                 text        NOT NULL,
  description           text        NOT NULL DEFAULT '',
  priority              text        NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status                text        NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled')),
  origin_type           text        NOT NULL CHECK (origin_type IN ('manual', 'incident')),
  origin_id             text,
  -- Logical reference to asset-service.
  asset_id              uuid,
  details               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- NULL when raised automatically.
  requested_by          text,
  requested_by_username text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  version               integer     NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);
-- One request per originating record, however often its event is delivered.
CREATE UNIQUE INDEX maintenance_requests_origin_idx ON maintenance_requests (tenant_id, origin_type, origin_id) WHERE origin_id IS NOT NULL;
CREATE INDEX maintenance_requests_status_idx ON maintenance_requests (tenant_id, status, submitted_at DESC);
CREATE INDEX maintenance_requests_requester_idx ON maintenance_requests (tenant_id, requested_by, submitted_at DESC);
CREATE INDEX maintenance_requests_asset_idx ON maintenance_requests (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE work_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  reference_no       text        NOT NULL,
  -- Exactly one work order per approved request.
  request_id         uuid        NOT NULL UNIQUE REFERENCES maintenance_requests (id),
  request_type       text        NOT NULL,
  pack_id            text        NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  priority           text        NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'completed', 'cancelled')),
  asset_id           uuid,
  origin_type        text        NOT NULL,
  origin_id          text,
  assignee_id        text,
  assignee_username  text,
  assigned_at        timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  completion_summary text,
  labor_hours        numeric(8, 2) CHECK (labor_hours IS NULL OR labor_hours >= 0),
  condition_after    text CHECK (condition_after IS NULL OR condition_after IN ('good', 'fair', 'poor', 'critical')),
  cancelled_reason   text,
  version            integer     NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX work_orders_status_idx ON work_orders (tenant_id, status, created_at DESC);
CREATE INDEX work_orders_assignee_idx ON work_orders (tenant_id, assignee_id) WHERE status IN ('assigned', 'in_progress');
CREATE INDEX work_orders_asset_idx ON work_orders (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE work_order_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  work_order_id  uuid        NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  entry_type     text        NOT NULL,
  message        text        NOT NULL,
  actor_username text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_events_idx ON work_order_events (work_order_id, occurred_at);

-- Local projection of assets (from asset-service events): validates references and gives readable names.
CREATE TABLE asset_projection (
  asset_id  uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code      text NOT NULL,
  name      text NOT NULL,
  category  text NOT NULL,
  status    text NOT NULL
);

ALTER TABLE request_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_types_isolation ON request_types USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE maintenance_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_counters_isolation ON maintenance_counters USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_requests_isolation ON maintenance_requests USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_orders_isolation ON work_orders USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE work_order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_order_events_isolation ON work_order_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE asset_projection ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_projection_isolation ON asset_projection USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
