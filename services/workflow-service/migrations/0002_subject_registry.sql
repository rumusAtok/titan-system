-- TITAN v3: workflows for any registered business subject, and definitions installed by industry packs.
-- Forward-only. Existing definitions, instances, tasks and decisions are not modified.

-- Controlled registry of subject types. Mirrors SUBJECT_TYPES in @titan/contracts;
-- a new type is added by a new migration, never at run time.
CREATE TABLE workflow_subject_types (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label           text    NOT NULL,
  -- Service that owns records of this type; NULL when no service in the platform does yet.
  owner_service   text,
  supports_return boolean NOT NULL DEFAULT false,
  registered_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON workflow_subject_types FROM {{APP_ROLE}};

INSERT INTO workflow_subject_types (key, label, owner_service, supports_return) VALUES
  ('case',                'Application or case', 'case-service',        true),
  ('incident',            'Incident',            'incident-service',    false),
  ('maintenance_request', 'Maintenance request', 'maintenance-service', false),
  ('service_request',     'Service request',     'maintenance-service', false),
  ('work_order',          'Work order',          NULL,                  false),
  ('inspection',          'Inspection',          NULL,                  false),
  ('purchase_request',    'Purchase request',    NULL,                  false),
  ('quality_deviation',   'Quality deviation',   NULL,                  false),
  ('contract',            'Contract',            NULL,                  false);

-- The fixed list ('case', 'incident') becomes a reference to the registry.
-- Every existing row satisfies the new constraint, because both values are registered above.
ALTER TABLE workflow_definitions DROP CONSTRAINT workflow_definitions_subject_type_check;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_subject_type_fkey FOREIGN KEY (subject_type) REFERENCES workflow_subject_types (key);

ALTER TABLE workflow_instances DROP CONSTRAINT workflow_instances_subject_type_check;
ALTER TABLE workflow_instances
  ADD CONSTRAINT workflow_instances_subject_type_fkey FOREIGN KEY (subject_type) REFERENCES workflow_subject_types (key);

-- Provenance of a definition version: the pack (and pack version) that installed it, if any.
ALTER TABLE workflow_definitions ADD COLUMN pack_id text;
ALTER TABLE workflow_definitions ADD COLUMN pack_version text;

-- Statistics by subject type.
CREATE INDEX workflow_instances_subject_type_idx ON workflow_instances (tenant_id, subject_type, status);
