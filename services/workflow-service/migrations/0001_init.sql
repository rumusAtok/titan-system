-- workflow-service: versioned approval processes, tasks, decisions, delegations, SLAs.

-- Master data: versioned process definitions.
CREATE TABLE workflow_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  key          text        NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version      integer     NOT NULL CHECK (version > 0),
  name         text        NOT NULL,
  subject_type text        NOT NULL CHECK (subject_type IN ('case', 'incident')),
  definition   jsonb       NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);
CREATE UNIQUE INDEX workflow_definitions_active_idx ON workflow_definitions (tenant_id, key) WHERE active;

-- One running process per business subject. A running instance stays bound
-- to the definition version it started with.
CREATE TABLE workflow_instances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  definition_id      uuid        NOT NULL REFERENCES workflow_definitions (id),
  definition_key     text        NOT NULL,
  definition_version integer     NOT NULL,
  subject_type       text        NOT NULL CHECK (subject_type IN ('case', 'incident')),
  subject_id         uuid        NOT NULL,
  reference          text        NOT NULL,
  title              text        NOT NULL,
  applicant_id       text,
  applicant_email    text,
  status             text        NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'returned', 'approved', 'rejected', 'cancelled')),
  current_stage_key  text,
  -- Increases each time the subject is resubmitted after being returned.
  cycle              integer     NOT NULL DEFAULT 1,
  context            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version            integer     NOT NULL DEFAULT 1,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id)
);
CREATE INDEX workflow_instances_status_idx ON workflow_instances (tenant_id, status);

CREATE TABLE workflow_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  instance_id         uuid        NOT NULL REFERENCES workflow_instances (id) ON DELETE CASCADE,
  cycle               integer     NOT NULL,
  stage_key           text        NOT NULL,
  stage_name          text        NOT NULL,
  role                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  decision            text        CHECK (decision IN ('approve', 'reject', 'return')),
  decided_by          text,
  decided_by_username text,
  on_behalf_of        text,
  comment             text,
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  due_at              timestamptz,
  escalate_to_role    text,
  escalated_at        timestamptz,
  closed_at           timestamptz,
  -- A stage can never hand the same role two tasks in the same cycle.
  UNIQUE (instance_id, cycle, stage_key, role)
);
-- Review inbox: pending tasks for a set of roles.
CREATE INDEX workflow_tasks_inbox_idx ON workflow_tasks (tenant_id, role, assigned_at) WHERE status = 'pending';
CREATE INDEX workflow_tasks_instance_idx ON workflow_tasks (instance_id);
-- SLA sweep.
CREATE INDEX workflow_tasks_due_idx ON workflow_tasks (due_at) WHERE status = 'pending' AND escalated_at IS NULL;

-- Immutable decision history. UNIQUE (task_id) is the database-level
-- guarantee that a task is decided at most once, whatever the application does.
CREATE TABLE workflow_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  instance_id         uuid        NOT NULL REFERENCES workflow_instances (id) ON DELETE CASCADE,
  task_id             uuid        NOT NULL UNIQUE REFERENCES workflow_tasks (id) ON DELETE CASCADE,
  stage_key           text        NOT NULL,
  decision            text        NOT NULL CHECK (decision IN ('approve', 'reject', 'return')),
  decided_by          text        NOT NULL,
  decided_by_username text        NOT NULL,
  on_behalf_of        text,
  comment             text,
  idempotency_key     text,
  decided_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_decisions_instance_idx ON workflow_decisions (instance_id, decided_at);

CREATE TABLE delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  from_user_id  text        NOT NULL,
  from_username text        NOT NULL,
  to_username   text        NOT NULL,
  role          text        NOT NULL,
  reason        text,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from),
  CHECK (from_username <> to_username)
);
CREATE INDEX delegations_lookup_idx ON delegations (tenant_id, to_username, role) WHERE revoked_at IS NULL;

ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_definitions_isolation ON workflow_definitions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_instances_isolation ON workflow_instances USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE workflow_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_tasks_isolation ON workflow_tasks USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE workflow_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_decisions_isolation ON workflow_decisions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE delegations ENABLE ROW LEVEL SECURITY;
CREATE POLICY delegations_isolation ON delegations USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Decisions are append-only for the application role.
REVOKE UPDATE, DELETE ON workflow_decisions FROM {{APP_ROLE}};

-- The SLA sweep must find overdue tasks across all tenants. Rather than give
-- the application role a way around row-level security, this narrowly scoped
-- function (running as the table owner) returns only task ids and tenants.
CREATE FUNCTION workflow_overdue_tasks(max_rows integer)
  RETURNS TABLE (task_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.id, t.tenant_id
    FROM workflow_tasks t
   WHERE t.status = 'pending' AND t.escalated_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < now()
   ORDER BY t.due_at
   LIMIT max_rows
$$;
REVOKE ALL ON FUNCTION workflow_overdue_tasks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_overdue_tasks(integer) TO {{APP_ROLE}};
