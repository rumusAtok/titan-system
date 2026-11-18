-- Sourcing (requests for quotation, quotations, award) and budgets per cost centre.

ALTER TABLE procurement_counters DROP CONSTRAINT procurement_counters_series_check;
ALTER TABLE procurement_counters ADD CONSTRAINT procurement_counters_series_check CHECK (series IN ('PR', 'PO', 'GR', 'RFQ'));

ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_origin_type_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_origin_type_check CHECK (origin_type IN ('manual', 'low_stock', 'work_order', 'rfq'));

CREATE TABLE cost_centres (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  code        text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name        text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL,
  cost_centre_id  uuid          NOT NULL REFERENCES cost_centres (id),
  year            integer       NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency        text          NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  updated_by      text          NOT NULL,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (cost_centre_id, year)
);

-- A purchase request may be charged to a cost centre; whether it exceeded the budget at
-- submission is recorded (and passed to the approval workflow).
ALTER TABLE purchase_requests
  ADD COLUMN cost_centre_id uuid REFERENCES cost_centres (id),
  ADD COLUMN over_budget    boolean NOT NULL DEFAULT false;

CREATE TABLE rfqs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL,
  reference_no          text        NOT NULL,
  title                 text        NOT NULL,
  delivery_location     text        NOT NULL,
  cost_centre_id        uuid REFERENCES cost_centres (id),
  respond_by            date        NOT NULL,
  status                text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'cancelled')),
  awarded_quotation_id  uuid,
  purchase_request_id   uuid REFERENCES purchase_requests (id),
  created_by            text        NOT NULL,
  created_by_id         text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);

CREATE TABLE rfq_lines (
  tenant_id  uuid          NOT NULL,
  rfq_id     uuid          NOT NULL REFERENCES rfqs (id),
  line_no    integer       NOT NULL,
  item_id    uuid          NOT NULL REFERENCES items (id),
  quantity   numeric(12,2) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (rfq_id, line_no)
);

CREATE TABLE rfq_suppliers (
  tenant_id    uuid NOT NULL,
  rfq_id       uuid NOT NULL REFERENCES rfqs (id),
  supplier_id  uuid NOT NULL REFERENCES suppliers (id),
  PRIMARY KEY (rfq_id, supplier_id)
);

-- A supplier's answer, recorded by a buyer (nothing is sent to or received from suppliers directly).
CREATE TABLE quotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL,
  rfq_id          uuid          NOT NULL REFERENCES rfqs (id),
  supplier_id     uuid          NOT NULL REFERENCES suppliers (id),
  -- [{ "line_no": 1, "unit_cost": 12.5 }]
  lines           jsonb         NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  total_amount    numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  currency        text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  lead_time_days  integer       CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  valid_until     date,
  note            text          NOT NULL DEFAULT '',
  recorded_by     text          NOT NULL,
  recorded_at     timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_centres', 'budgets', 'rfqs', 'rfq_lines', 'rfq_suppliers', 'quotations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END $$;
