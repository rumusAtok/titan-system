-- audit-service: append-only record of business activity and security events.

CREATE TABLE audit_events (
  seq             bigserial   PRIMARY KEY,
  -- The source event id; makes recording idempotent.
  event_id        uuid        NOT NULL UNIQUE,
  tenant_id       uuid        NOT NULL,
  event_type      text        NOT NULL,
  category        text        NOT NULL,
  producer        text        NOT NULL,
  aggregate_type  text        NOT NULL,
  aggregate_id    text        NOT NULL,
  actor_id        text,
  actor_username  text,
  actor_type      text,
  correlation_id  text        NOT NULL,
  causation_id    text,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb       NOT NULL
);
CREATE INDEX audit_events_time_idx ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX audit_events_aggregate_idx ON audit_events (tenant_id, aggregate_id, occurred_at);
CREATE INDEX audit_events_type_idx ON audit_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX audit_events_correlation_idx ON audit_events (tenant_id, correlation_id);
CREATE INDEX audit_events_actor_idx ON audit_events (tenant_id, actor_username, occurred_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_isolation ON audit_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Append-only, enforced twice:
-- 1. the application role has no UPDATE/DELETE/TRUNCATE privilege;
-- 2. a trigger refuses modification by any role, including the owner.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM {{APP_ROLE}};

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% is not permitted)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_no_change
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
