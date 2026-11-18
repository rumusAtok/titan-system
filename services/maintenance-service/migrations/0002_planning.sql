-- Maintenance planning: preventive maintenance plans, inspection plans and rounds,
-- parts used on work orders (booked out of stores by procurement-service) and labour cost.

-- Requests and work orders can now come from a preventive plan or an inspection finding.
ALTER TABLE maintenance_requests DROP CONSTRAINT maintenance_requests_origin_type_check;
ALTER TABLE maintenance_requests
  ADD CONSTRAINT maintenance_requests_origin_type_check CHECK (origin_type IN ('manual', 'incident', 'schedule', 'inspection'));

ALTER TABLE maintenance_counters DROP CONSTRAINT maintenance_counters_series_check;
ALTER TABLE maintenance_counters ADD CONSTRAINT maintenance_counters_series_check CHECK (series IN ('MR', 'WO', 'IR'));

-- Parts and labour on a work order.
ALTER TABLE work_orders
  ADD COLUMN parts          jsonb         NOT NULL DEFAULT '[]',
  ADD COLUMN parts_cost     numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN labor_rate     numeric(10, 2),
  ADD COLUMN labor_cost     numeric(12, 2),
  ADD COLUMN cost_currency  text,
  ADD COLUMN estimated_hours numeric(8, 2),
  ADD COLUMN checklist      text[]        NOT NULL DEFAULT '{}';

-- Tenant settings of the maintenance capability.
CREATE TABLE maintenance_settings (
  tenant_id            uuid PRIMARY KEY,
  labor_rate_per_hour  numeric(10, 2) NOT NULL DEFAULT 45 CHECK (labor_rate_per_hour >= 0),
  currency             text           NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  parts_store          text           NOT NULL DEFAULT 'MAIN-STORE',
  updated_by           text,
  updated_at           timestamptz    NOT NULL DEFAULT now()
);

-- Preventive maintenance: planned work on an asset at a fixed interval.
CREATE TABLE pm_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name             text        NOT NULL,
  description      text        NOT NULL DEFAULT '',
  asset_id         uuid        NOT NULL,
  request_type     text        NOT NULL,
  priority         text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  interval_days    integer     NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  lead_days        integer     NOT NULL DEFAULT 3 CHECK (lead_days BETWEEN 0 AND 90),
  next_due_on      date        NOT NULL,
  estimated_hours  numeric(8, 2),
  checklist        text[]      NOT NULL DEFAULT '{}',
  active           boolean     NOT NULL DEFAULT true,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          integer     NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE INDEX pm_plans_due_idx ON pm_plans (next_due_on) WHERE active;

-- One generated work order per plan and due date (idempotent generation).
CREATE TABLE pm_plan_runs (
  plan_id        uuid        NOT NULL REFERENCES pm_plans (id),
  due_on         date        NOT NULL,
  tenant_id      uuid        NOT NULL,
  work_order_id  uuid        NOT NULL REFERENCES work_orders (id),
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, due_on)
);

-- Inspection plans: a checklist done at an interval, on an asset or at a place.
CREATE TABLE inspection_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL,
  code                   text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name                   text        NOT NULL,
  asset_id               uuid,
  location               text        NOT NULL DEFAULT '',
  -- [{ "key": "...", "question": "...", "kind": "pass_fail" | "number", "min": n, "max": n, "unit": "..." }]
  checklist              jsonb       NOT NULL CHECK (jsonb_typeof(checklist) = 'array'),
  interval_days          integer     NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  next_due_on            date        NOT NULL,
  assigned_role          text        NOT NULL,
  -- Request type raised for each failed item (e.g. inspection-finding, equipment-repair).
  finding_request_type   text        NOT NULL,
  active                 boolean     NOT NULL DEFAULT true,
  created_by             text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE INDEX inspection_plans_due_idx ON inspection_plans (next_due_on) WHERE active;

CREATE TABLE inspection_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  reference_no   text        NOT NULL,
  plan_id        uuid        NOT NULL REFERENCES inspection_plans (id),
  due_on         date        NOT NULL,
  status         text        NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'completed', 'skipped')),
  asset_id       uuid,
  checklist      jsonb       NOT NULL,
  results        jsonb,
  findings       integer     NOT NULL DEFAULT 0,
  notes          text        NOT NULL DEFAULT '',
  performed_by   text,
  performed_by_id text,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, due_on),
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX inspection_rounds_status_idx ON inspection_rounds (tenant_id, status, due_on);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_settings', 'pm_plans', 'pm_plan_runs', 'inspection_plans', 'inspection_rounds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END $$;

-- Planning sweep: plans whose next due date is within their lead time, across tenants (ids only).
CREATE FUNCTION maintenance_plans_due(max_rows integer)
  RETURNS TABLE (kind text, plan_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  (SELECT 'pm', p.id, p.tenant_id FROM pm_plans p WHERE p.active AND p.next_due_on - p.lead_days <= current_date ORDER BY p.next_due_on LIMIT max_rows)
  UNION ALL
  (SELECT 'inspection', i.id, i.tenant_id FROM inspection_plans i WHERE i.active AND i.next_due_on <= current_date + 1 ORDER BY i.next_due_on LIMIT max_rows)
$$;
REVOKE ALL ON FUNCTION maintenance_plans_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_plans_due(integer) TO {{APP_ROLE}};
