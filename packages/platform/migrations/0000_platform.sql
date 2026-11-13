-- Platform infrastructure tables present in every service-owned database.
-- Applied by the shared migration runner before the service's own migrations.

-- Tenant of the current transaction. Set by the service with
--   SELECT set_config('app.tenant_id', <uuid from the verified token>, true)
-- Returns NULL when unset, so RLS policies then match no rows (fail closed).
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Transactional outbox: rows are written in the same transaction as the
-- business change and published to JetStream by the relay.
CREATE TABLE outbox (
  seq          bigserial PRIMARY KEY,
  event_id     uuid        NOT NULL UNIQUE,
  event_type   text        NOT NULL,
  tenant_id    uuid        NOT NULL,
  event        jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (seq) WHERE published_at IS NULL;
CREATE INDEX outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL;

-- Inbox: one row per (consumer, event) makes event handling idempotent
-- under at-least-once delivery.
CREATE TABLE inbox (
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  event_type   text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX inbox_processed_idx ON inbox (processed_at);

-- Messages that could not be processed after the bounded number of retries.
CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer    text        NOT NULL,
  subject     text        NOT NULL,
  event_id    text,
  event_type  text,
  reason      text        NOT NULL,
  error       text        NOT NULL,
  deliveries  integer     NOT NULL,
  payload     text        NOT NULL,
  failed_at   timestamptz NOT NULL DEFAULT now()
);
