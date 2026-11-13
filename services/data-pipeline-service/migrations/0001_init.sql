-- data-pipeline-service: bronze landing zone, run history, catalog, lineage, quality results.
--
-- These tables hold PLATFORM-level pipeline metadata plus the raw (bronze)
-- event copies of all tenants. The service exposes metadata only; raw event
-- payloads are never served by its API. Tenant-facing analytical data is
-- served by analytics-service, whose tables carry row-level security.

-- BRONZE: raw events exactly as received, plus source metadata.
CREATE TABLE bronze_events (
  seq         bigserial   PRIMARY KEY,
  event_id    uuid        NOT NULL UNIQUE,
  event_type  text        NOT NULL,
  tenant_id   uuid        NOT NULL,
  producer    text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  -- Source metadata.
  source      text        NOT NULL,
  stream_seq  bigint      NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  envelope    jsonb       NOT NULL
);
-- Incremental reads: "everything after the watermark, in order".
CREATE INDEX bronze_events_type_seq_idx ON bronze_events (event_type, seq);

CREATE TABLE pipeline_state (
  pipeline   text PRIMARY KEY,
  -- Highest bronze sequence already folded into silver.
  watermark  bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pipeline_state (pipeline) VALUES ('operations');

-- Execution history, including failures and retries.
CREATE TABLE pipeline_runs (
  id             uuid PRIMARY KEY,
  pipeline       text        NOT NULL,
  trigger        text        NOT NULL CHECK (trigger IN ('schedule', 'manual', 'retry')),
  status         text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt        integer     NOT NULL DEFAULT 1,
  -- The failed run this run retries, if any.
  retry_of       uuid REFERENCES pipeline_runs (id),
  triggered_by   text        NOT NULL,
  watermark_from bigint      NOT NULL,
  watermark_to   bigint,
  events_read    integer     NOT NULL DEFAULT 0,
  rows_written   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX pipeline_runs_started_idx ON pipeline_runs (started_at DESC);

-- Dataset catalog with ownership metadata.
CREATE TABLE dataset_catalog (
  name          text PRIMARY KEY,
  layer         text        NOT NULL CHECK (layer IN ('bronze', 'silver', 'gold')),
  owner         text        NOT NULL,
  steward       text        NOT NULL,
  description   text        NOT NULL,
  location      text        NOT NULL,
  primary_key   text[]      NOT NULL,
  classification text       NOT NULL DEFAULT 'internal',
  row_count     bigint,
  last_run_id   uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Lineage: which sources and transformation produced each dataset, per run.
CREATE TABLE lineage_edges (
  id             bigserial PRIMARY KEY,
  run_id         uuid        NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
  target_dataset text        NOT NULL,
  source_dataset text        NOT NULL,
  transformation text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lineage_edges_target_idx ON lineage_edges (target_dataset, created_at DESC);
CREATE INDEX lineage_edges_run_idx ON lineage_edges (run_id);

CREATE TABLE quality_results (
  id          bigserial PRIMARY KEY,
  run_id      uuid        NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
  dataset     text        NOT NULL,
  rule        text        NOT NULL,
  passed      boolean     NOT NULL,
  failed_rows bigint      NOT NULL,
  total_rows  bigint      NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_results_run_idx ON quality_results (run_id);
