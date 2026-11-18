-- video-service: camera registry, audited viewing sessions, recording metadata and incident markers.
-- No video is stored or processed here: recordings are references to clips held by an external
-- video management system, and a stream URL is only handed to an authorised viewer who states a purpose.

CREATE TABLE cameras (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  code              text NOT NULL,
  name              text NOT NULL,
  location_note     text NOT NULL DEFAULT '',
  asset_id          uuid,
  latitude          double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude         double precision CHECK (longitude BETWEEN -180 AND 180),
  stream_url        text,
  status            text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'maintenance', 'decommissioned')),
  last_seen_at      timestamptz,
  retention_days    integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  privacy_masking   boolean NOT NULL DEFAULT false,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Who watched which camera, when and why (append-only apart from closing the session).
CREATE TABLE view_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  camera_id        uuid NOT NULL REFERENCES cameras (id),
  viewer_id        text NOT NULL,
  viewer_username  text NOT NULL,
  purpose          text NOT NULL,
  incident_id      uuid,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX view_sessions_camera_idx ON view_sessions (tenant_id, camera_id, started_at DESC);
REVOKE DELETE, TRUNCATE ON view_sessions FROM {{APP_ROLE}};

CREATE TABLE recordings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  camera_id        uuid NOT NULL REFERENCES cameras (id),
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  -- Reference to the clip in the external video management system (not a file here).
  storage_ref      text,
  size_bytes       bigint CHECK (size_bytes >= 0),
  retain_until     date NOT NULL,
  legal_hold       boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'expired')),
  registered_by    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at > started_at)
);
CREATE INDEX recordings_camera_idx ON recordings (tenant_id, camera_id, started_at DESC);
CREATE INDEX recordings_expiry_idx ON recordings (retain_until) WHERE status = 'available' AND NOT legal_hold;

CREATE TABLE markers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  camera_id     uuid NOT NULL REFERENCES cameras (id),
  recording_id  uuid REFERENCES recordings (id),
  incident_id   uuid,
  at            timestamptz NOT NULL,
  label         text NOT NULL,
  note          text NOT NULL DEFAULT '',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX markers_incident_idx ON markers (tenant_id, incident_id) WHERE incident_id IS NOT NULL;

-- Incidents this tenant has (projection of incident-service events) so markers can refer to them.
CREATE TABLE incident_refs (
  incident_id   uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  reference_no  text NOT NULL,
  title         text NOT NULL,
  severity      text NOT NULL,
  created_at    timestamptz NOT NULL
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cameras', 'view_sessions', 'recordings', 'markers', 'incident_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_isolation', t);
  END LOOP;
END $$;

-- Retention sweep: recordings past their retention date and not on legal hold, ids only.
CREATE FUNCTION recordings_expired(max_rows integer)
  RETURNS TABLE (recording_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT r.id, r.tenant_id FROM recordings r
   WHERE r.status = 'available' AND NOT r.legal_hold AND r.retain_until < current_date
   ORDER BY r.retain_until
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION recordings_expired(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recordings_expired(integer) TO {{APP_ROLE}};
