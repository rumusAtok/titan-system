-- notification-service: in-app notifications, e-mail delivery state, retry scheduling.

CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  -- Supplied by the requester; makes a repeated request a no-op.
  dedupe_key        text        NOT NULL,
  channel           text        NOT NULL CHECK (channel IN ('in_app', 'email')),
  category          text        NOT NULL,
  external          boolean     NOT NULL DEFAULT false,
  recipient_user_id text,
  recipient_role    text,
  recipient_address text,
  subject           text        NOT NULL,
  body              text        NOT NULL,
  reference_type    text,
  reference_id      text,
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts          integer     NOT NULL DEFAULT 0,
  max_attempts      integer     NOT NULL DEFAULT 5,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  adapter           text,
  sent_at           timestamptz,
  source_event_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_user_id IS NOT NULL OR recipient_role IS NOT NULL),
  UNIQUE (tenant_id, dedupe_key)
);
-- A user's notification list.
CREATE INDEX notifications_user_idx ON notifications (tenant_id, recipient_user_id, created_at DESC);
CREATE INDEX notifications_role_idx ON notifications (tenant_id, recipient_role, created_at DESC);
-- Delivery worker.
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'pending';

-- Read state is per user, because a role-addressed notification has many readers.
CREATE TABLE notification_reads (
  notification_id uuid        NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  tenant_id       uuid        NOT NULL,
  user_id         text        NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_isolation ON notifications USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_reads_isolation ON notification_reads USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- The delivery worker needs to find due notifications in every tenant.
-- It gets ids only; each delivery then runs in that tenant's own context.
CREATE FUNCTION notifications_due(max_rows integer)
  RETURNS TABLE (notification_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT n.id, n.tenant_id
    FROM notifications n
   WHERE n.status = 'pending' AND n.next_attempt_at <= now()
   ORDER BY n.next_attempt_at
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION notifications_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications_due(integer) TO {{APP_ROLE}};
