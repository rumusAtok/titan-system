-- integration-service: signed inbound webhooks and outbound event subscriptions.
-- Secrets are stored sealed (AES-256-GCM, key from INTEGRATION_SECRET_KEY), never in plain text.

CREATE TABLE inbound_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'incident_report' CHECK (kind IN ('incident_report')),
  sealed_secret     text NOT NULL,
  default_severity  text NOT NULL DEFAULT 'warning' CHECK (default_severity IN ('info', 'warning', 'critical')),
  default_category  text,
  active            boolean NOT NULL DEFAULT true,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  secret_rotated_at timestamptz NOT NULL DEFAULT now(),
  last_received_at  timestamptz,
  UNIQUE (tenant_id, name)
);

-- Every request that reached a known endpoint, accepted or not (append-only).
CREATE TABLE inbound_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  endpoint_id  uuid NOT NULL REFERENCES inbound_endpoints (id),
  event_id     text,
  status       text NOT NULL CHECK (status IN ('accepted', 'duplicate', 'rejected')),
  reason       text,
  external_id  text,
  body_sha256  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
-- Replay protection: a sender's event id is accepted once per endpoint.
CREATE UNIQUE INDEX inbound_messages_event_once ON inbound_messages (endpoint_id, event_id) WHERE status = 'accepted';
CREATE INDEX inbound_messages_endpoint_idx ON inbound_messages (tenant_id, endpoint_id, received_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON inbound_messages FROM {{APP_ROLE}};

CREATE TABLE subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  name           text NOT NULL,
  target_url     text NOT NULL,
  event_types    text[] NOT NULL CHECK (cardinality(event_types) > 0),
  sealed_secret  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  subscription_id  uuid NOT NULL REFERENCES subscriptions (id),
  event_id         uuid NOT NULL,
  event_type       text NOT NULL,
  body             jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_subscription_idx ON deliveries (tenant_id, subscription_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbound_endpoints', 'inbound_messages', 'subscriptions', 'deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END $$;

-- An inbound request names only the endpoint id. This returns the owning tenant (nothing else),
-- so the request can then be handled inside that tenant's transaction.
CREATE FUNCTION inbound_endpoint_tenant(endpoint uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM inbound_endpoints WHERE id = endpoint
$$;
REVOKE ALL ON FUNCTION inbound_endpoint_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inbound_endpoint_tenant(uuid) TO {{APP_ROLE}};

-- Delivery worker: due deliveries across tenants, ids only.
CREATE FUNCTION deliveries_due(max_rows integer)
  RETURNS TABLE (delivery_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.id, d.tenant_id FROM deliveries d
   WHERE d.status = 'pending' AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION deliveries_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deliveries_due(integer) TO {{APP_ROLE}};
