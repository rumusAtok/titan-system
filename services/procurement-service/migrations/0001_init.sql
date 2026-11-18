-- procurement-service: suppliers, stock items and levels, purchase requests, purchase orders, goods receipts.

CREATE TABLE procurement_counters (
  tenant_id uuid    NOT NULL,
  series    text    NOT NULL CHECK (series IN ('PR', 'PO', 'GR')),
  year      integer NOT NULL,
  last_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, series, year)
);

CREATE TABLE suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  code          text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name          text        NOT NULL,
  contact_email text,
  phone         text,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid          NOT NULL,
  sku                   text          NOT NULL CHECK (sku ~ '^[A-Z0-9][A-Z0-9_-]{1,40}$'),
  name                  text          NOT NULL,
  category              text          NOT NULL DEFAULT 'general',
  unit                  text          NOT NULL DEFAULT 'each',
  unit_cost             numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  currency              text          NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  -- At or below this level a replenishment request is raised automatically.
  reorder_level         numeric(12,2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_quantity      numeric(12,2) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  preferred_supplier_id uuid REFERENCES suppliers (id),
  active                boolean       NOT NULL DEFAULT true,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE stock_levels (
  tenant_id  uuid          NOT NULL,
  item_id    uuid          NOT NULL REFERENCES items (id),
  location   text          NOT NULL,
  -- The database refuses negative stock, whatever the application does.
  on_hand    numeric(12,2) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location)
);

-- Every change of stock, append-only.
CREATE TABLE stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid          NOT NULL,
  item_id        uuid          NOT NULL REFERENCES items (id),
  location       text          NOT NULL,
  quantity       numeric(12,2) NOT NULL CHECK (quantity <> 0),
  kind           text          NOT NULL CHECK (kind IN ('receipt', 'issue', 'adjustment')),
  reference_type text,
  reference_id   text,
  note           text,
  moved_by       text          NOT NULL,
  moved_at       timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_item_idx ON stock_movements (item_id, moved_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM {{APP_ROLE}};

CREATE TABLE purchase_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid          NOT NULL,
  reference_no          text          NOT NULL,
  title                 text          NOT NULL,
  justification         text          NOT NULL DEFAULT '',
  supplier_id           uuid          NOT NULL REFERENCES suppliers (id),
  delivery_location     text          NOT NULL,
  total_amount          numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  currency              text          NOT NULL,
  status                text          NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled', 'ordered')),
  origin_type           text          NOT NULL CHECK (origin_type IN ('manual', 'low_stock', 'work_order')),
  origin_id             text,
  requested_by          text,
  requested_by_username text,
  submitted_at          timestamptz   NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  version               integer       NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, reference_no)
);
-- At most one open replenishment request per item and location.
CREATE UNIQUE INDEX purchase_requests_open_low_stock_idx ON purchase_requests (tenant_id, origin_id)
  WHERE origin_type = 'low_stock' AND status IN ('submitted', 'approved', 'ordered');
CREATE INDEX purchase_requests_status_idx ON purchase_requests (tenant_id, status, submitted_at DESC);

CREATE TABLE purchase_request_lines (
  tenant_id           uuid          NOT NULL,
  purchase_request_id uuid          NOT NULL REFERENCES purchase_requests (id) ON DELETE CASCADE,
  line_no             integer       NOT NULL,
  item_id             uuid          NOT NULL REFERENCES items (id),
  quantity            numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_cost           numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  PRIMARY KEY (purchase_request_id, line_no)
);

CREATE TABLE purchase_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid          NOT NULL,
  reference_no        text          NOT NULL,
  -- Exactly one order per approved request.
  purchase_request_id uuid          NOT NULL UNIQUE REFERENCES purchase_requests (id),
  supplier_id         uuid          NOT NULL REFERENCES suppliers (id),
  delivery_location   text          NOT NULL,
  total_amount        numeric(14,2) NOT NULL,
  currency            text          NOT NULL,
  status              text          NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'partially_received', 'received', 'cancelled')),
  issued_at           timestamptz   NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  version             integer       NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, reference_no)
);

CREATE TABLE purchase_order_lines (
  tenant_id         uuid          NOT NULL,
  purchase_order_id uuid          NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  line_no           integer       NOT NULL,
  item_id           uuid          NOT NULL REFERENCES items (id),
  quantity_ordered  numeric(12,2) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received numeric(12,2) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost         numeric(12,2) NOT NULL,
  PRIMARY KEY (purchase_order_id, line_no),
  -- Never more received than ordered.
  CHECK (quantity_received <= quantity_ordered)
);

CREATE TABLE goods_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  reference_no      text        NOT NULL,
  purchase_order_id uuid        NOT NULL REFERENCES purchase_orders (id),
  lines             jsonb       NOT NULL,
  note              text        NOT NULL DEFAULT '',
  received_by       text        NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_no)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['procurement_counters', 'suppliers', 'items', 'stock_levels', 'stock_movements', 'purchase_requests',
                           'purchase_request_lines', 'purchase_orders', 'purchase_order_lines', 'goods_receipts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END
$$;
