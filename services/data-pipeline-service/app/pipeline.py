"""Pipeline orchestration: bronze -> silver -> gold, with run history,
watermark, catalog, lineage and quality results.

Incremental and idempotent:
- a run reads only bronze events after the stored watermark;
- silver merges are idempotent, gold is recomputed from silver;
- the watermark advances in the same database transaction that records the
  run as succeeded. If anything fails first, the watermark stays put and the
  next run (or an explicit retry) processes the same events again, safely.
"""

from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import polars as pl
from psycopg.types.json import Jsonb
from titan_pykit import Database, DomainError

from . import transforms
from .gold import GOLD, build_gold

PIPELINE = "operations"
BRONZE_RETENTION_DAYS = int(os.environ.get("BRONZE_RETENTION_DAYS", "30"))
MAX_EVENTS_PER_RUN = 250_000

OWNERS = {
    "bronze_events": ("data-platform", "Raw platform events as received from the event stream"),
    "cases": ("case-service", "One row per submitted application with its outcome"),
    "workflow_tasks": ("workflow-service", "One row per workflow task with its current status"),
    "incidents": ("incident-service", "One row per incident with acknowledgment and resolution times"),
    "devices": ("device-service", "One row per IoT device with its current status"),
    "assets": ("asset-service", "One row per infrastructure asset with lifecycle and maintenance state"),
    "measurements": ("telemetry-service", "Accepted sensor readings with quality flags, partitioned by day"),
}


class SimulatedFailure(RuntimeError):
    pass


def _write_atomic(df: pl.DataFrame, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    df.write_parquet(temporary)
    temporary.replace(target)


def _read(path: Path) -> pl.DataFrame | None:
    return pl.read_parquet(path) if path.exists() else None


class PipelineRunner:
    def __init__(self, db: Database, lake: Path, log) -> None:
        self._db = db
        self._lake = lake
        self._log = log
        # One run at a time (single pipeline replica; see docs/architecture/data-engineering.md).
        self._lock = threading.Lock()

    @property
    def silver_dir(self) -> Path:
        return self._lake / "silver"

    @property
    def gold_dir(self) -> Path:
        return self._lake / "gold"

    def ensure_layout(self) -> None:
        """Creates empty, correctly typed silver files so gold queries work before any data exists."""
        for name in ("cases", "workflow_tasks", "incidents", "devices", "assets"):
            path = self.silver_dir / f"{name}.parquet"
            if not path.exists():
                _write_atomic(transforms.frame(name, []), path)
        placeholder = self.silver_dir / "measurements" / "_schema.parquet"
        if not placeholder.exists():
            _write_atomic(transforms.frame("measurements", []), placeholder)

    # -- one run -------------------------------------------------------------------

    def execute(self, trigger: str, triggered_by: str, retry_of: str | None = None, simulate_failure: bool = False) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            raise DomainError.conflict("run_in_progress", "a pipeline run is already in progress")
        run_id = str(uuid.uuid4())
        try:
            with self._db.tx(None) as conn:
                watermark = conn.execute("SELECT watermark FROM pipeline_state WHERE pipeline = %s", (PIPELINE,)).fetchone()["watermark"]
                attempt = 1
                if retry_of:
                    previous = conn.execute("SELECT status, attempt FROM pipeline_runs WHERE id = %s", (retry_of,)).fetchone()
                    if not previous:
                        raise DomainError.not_found("pipeline run")
                    if previous["status"] != "failed":
                        raise DomainError.conflict("not_retryable", "only a failed run can be retried")
                    attempt = previous["attempt"] + 1
                conn.execute(
                    """INSERT INTO pipeline_runs (id, pipeline, trigger, status, attempt, retry_of, triggered_by, watermark_from)
                       VALUES (%s, %s, %s, 'running', %s, %s, %s, %s)""",
                    (run_id, PIPELINE, trigger, attempt, retry_of, triggered_by, watermark),
                )
            try:
                return self._run(run_id, watermark, simulate_failure)
            except Exception as exc:
                with self._db.tx(None) as conn:
                    conn.execute(
                        "UPDATE pipeline_runs SET status = 'failed', error = %s, finished_at = now() WHERE id = %s",
                        (f"{type(exc).__name__}: {exc}"[:2000], run_id),
                    )
                self._log.error("pipeline run failed", run_id=run_id, error=str(exc))
                return self.describe(run_id)
        finally:
            self._lock.release()

    def _run(self, run_id: str, watermark: int, simulate_failure: bool) -> dict[str, Any]:
        self.ensure_layout()
        now = datetime.now(timezone.utc)

        # BRONZE -> incremental read after the watermark.
        with self._db.tx(None, read_only=True) as conn:
            rows = conn.execute(
                "SELECT seq, envelope FROM bronze_events WHERE seq > %s ORDER BY seq LIMIT %s", (watermark, MAX_EVENTS_PER_RUN)
            ).fetchall()
        events = [(row["seq"], row["envelope"]) for row in rows]
        new_watermark = events[-1][0] if events else watermark

        # SILVER -> validate, standardise, deduplicate.
        changes, malformed = transforms.extract_changes(events)
        written: dict[str, int] = {}
        quality: list[transforms.QualityResult] = [transforms.QualityResult("bronze_events", "event_maps_to_schema", malformed == 0, malformed, len(events))]

        for name in ("cases", "workflow_tasks", "incidents", "devices", "assets"):
            path = self.silver_dir / f"{name}.parquet"
            merged = transforms.merge_latest(name, _read(path), changes[name])
            valid, results = transforms.validate(name, merged, now)
            quality.extend(results)
            _write_atomic(valid, path)
            written[name] = valid.height

        new_measurements, results = transforms.validate("measurements", changes["measurements"], now)
        quality.extend(results)
        if new_measurements.height:
            by_day = new_measurements.with_columns(pl.col("observed_at").dt.strftime("%Y-%m-%d").alias("_day"))
            for (day,), part in by_day.group_by("_day"):
                path = self.silver_dir / "measurements" / f"date={day}.parquet"
                _write_atomic(transforms.merge_append("measurements", _read(path), part.drop("_day")), path)
        written["measurements"] = sum(
            pl.scan_parquet(p).select(pl.len()).collect().item() for p in (self.silver_dir / "measurements").glob("date=*.parquet")
        )

        if simulate_failure:
            # Fails AFTER silver was written and BEFORE the watermark moves:
            # exactly the half-finished state the retry path must cope with.
            raise SimulatedFailure("failure injected after the silver stage")

        # GOLD -> recomputed from silver.
        gold_counts = build_gold(self.silver_dir, self.gold_dir, transforms.ts(now))
        written.update({f"gold.{k}": v for k, v in gold_counts.items()})

        # Commit: run record, watermark, catalog, lineage and quality together.
        with self._db.tx(None) as conn:
            conn.execute("UPDATE pipeline_state SET watermark = %s, updated_at = now() WHERE pipeline = %s", (new_watermark, PIPELINE))
            conn.execute(
                """UPDATE pipeline_runs SET status = 'succeeded', watermark_to = %s, events_read = %s, rows_written = %s, finished_at = now()
                    WHERE id = %s""",
                (new_watermark, len(events), Jsonb(written), run_id),
            )
            # Bronze retention: only events already folded into silver are ever removed.
            conn.execute(
                "DELETE FROM bronze_events WHERE seq <= %s AND ingested_at < now() - make_interval(days => %s)",
                (new_watermark, BRONZE_RETENTION_DAYS),
            )
            bronze_total = conn.execute("SELECT count(*) AS n FROM bronze_events").fetchone()["n"]
            catalog = [("bronze_events", "bronze", "postgresql: titan_pipeline.bronze_events", ["event_id"], bronze_total)]
            for name in transforms.SCHEMAS:
                location = "lake: silver/measurements/date=*.parquet" if name == "measurements" else f"lake: silver/{name}.parquet"
                catalog.append((name, "silver", location, transforms.KEYS[name], written[name]))
                conn.execute(
                    "INSERT INTO lineage_edges (run_id, target_dataset, source_dataset, transformation) VALUES (%s, %s, 'bronze_events', %s)",
                    (run_id, name, "merge of event types: " + ", ".join(transforms.SOURCES[name])),
                )
            for name, (description, inputs, _sql) in GOLD.items():
                catalog.append((f"gold.{name}", "gold", f"lake: gold/{name}.parquet", ["tenant_id"], gold_counts[name]))
                for source in inputs:
                    conn.execute(
                        "INSERT INTO lineage_edges (run_id, target_dataset, source_dataset, transformation) VALUES (%s, %s, %s, %s)",
                        (run_id, f"gold.{name}", source, f"duckdb aggregation: {description}"),
                    )
            for name, layer, location, key, count in catalog:
                base = name.removeprefix("gold.")
                owner, description = OWNERS.get(name, ("analytics-service", GOLD[base][0] if base in GOLD else name))
                conn.execute(
                    """INSERT INTO dataset_catalog (name, layer, owner, steward, description, location, primary_key, row_count, last_run_id)
                       VALUES (%s, %s, %s, 'data-platform', %s, %s, %s, %s, %s)
                       ON CONFLICT (name) DO UPDATE SET row_count = EXCLUDED.row_count, last_run_id = EXCLUDED.last_run_id,
                         description = EXCLUDED.description, location = EXCLUDED.location, updated_at = now()""",
                    (name, layer, owner, description, location, key, count, run_id),
                )
            for result in quality:
                conn.execute(
                    "INSERT INTO quality_results (run_id, dataset, rule, passed, failed_rows, total_rows) VALUES (%s, %s, %s, %s, %s, %s)",
                    (run_id, result.dataset, result.rule, result.passed, result.failed_rows, result.total_rows),
                )
        self._log.info("pipeline run succeeded", run_id=run_id, events=len(events), watermark=new_watermark)
        return self.describe(run_id)

    # -- queries -------------------------------------------------------------------

    def describe(self, run_id: str) -> dict[str, Any]:
        with self._db.tx(None, read_only=True) as conn:
            run = conn.execute("SELECT * FROM pipeline_runs WHERE id = %s", (run_id,)).fetchone()
            if not run:
                raise DomainError.not_found("pipeline run")
            run["quality"] = conn.execute(
                "SELECT dataset, rule, passed, failed_rows, total_rows FROM quality_results WHERE run_id = %s ORDER BY dataset, rule", (run_id,)
            ).fetchall()
            run["lineage"] = conn.execute(
                "SELECT target_dataset, source_dataset, transformation FROM lineage_edges WHERE run_id = %s ORDER BY target_dataset, source_dataset", (run_id,)
            ).fetchall()
            return run

    def status(self) -> dict[str, Any]:
        with self._db.tx(None, read_only=True) as conn:
            state = conn.execute("SELECT watermark, updated_at FROM pipeline_state WHERE pipeline = %s", (PIPELINE,)).fetchone()
            bronze = conn.execute("SELECT COALESCE(max(seq), 0) AS latest, count(*) AS total, max(ingested_at) AS last_ingested_at FROM bronze_events").fetchone()
            last = conn.execute(
                "SELECT id, status, trigger, attempt, started_at, finished_at, events_read, error FROM pipeline_runs ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            last_ok = conn.execute("SELECT max(finished_at) AS at FROM pipeline_runs WHERE status = 'succeeded'").fetchone()["at"]
        return {
            "pipeline": PIPELINE,
            "watermark": state["watermark"],
            "bronze_latest_seq": bronze["latest"],
            "bronze_events": bronze["total"],
            "bronze_last_ingested_at": bronze["last_ingested_at"],
            "pending_events": bronze["latest"] - state["watermark"],
            "last_run": last,
            "last_success_at": last_ok,
        }
