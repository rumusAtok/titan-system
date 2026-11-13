from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Query
from psycopg.types.json import Jsonb
from pydantic import BaseModel
from titan_pykit import DomainError, Principal, ServiceTokenProvider, build_envelope, create_app, require_roles
from titan_pykit.auth import PLATFORM_TENANT_ID

from .pipeline import PipelineRunner

READERS = ("analyst", "tenant_admin", "auditor", "platform_admin")
OPERATORS = ("analyst", "tenant_admin", "platform_admin")

# Event families landed in bronze.
BRONZE_SUBJECTS = ["case.>", "workflow.>", "incident.>", "device.>", "asset.>", "alert.>", "telemetry.measurement.accepted.v1"]


async def on_start(app: FastAPI) -> None:
    settings = app.state.settings
    log = app.state.log
    db = app.state.db
    runner = PipelineRunner(db, Path(settings.get("LAKE_DIR", "/lake")), log)
    app.state.runner = runner
    app.state.tokens = (
        ServiceTokenProvider(settings.oidc_token_url, settings.client_id, settings.client_secret)
        if settings.oidc_token_url and settings.client_id and settings.client_secret
        else None
    )
    await asyncio.to_thread(runner.ensure_layout)

    def land(envelope: dict[str, Any], stream_seq: int) -> None:
        with db.tx(None) as conn:
            # event_id is unique: a redelivered event is landed once.
            conn.execute(
                """INSERT INTO bronze_events (event_id, event_type, tenant_id, producer, occurred_at, source, stream_seq, envelope)
                   VALUES (%s, %s, %s, %s, %s, 'nats:TITAN_EVENTS', %s, %s)
                   ON CONFLICT (event_id) DO NOTHING""",
                (envelope["event_id"], envelope["event_type"], envelope["tenant_id"], envelope.get("producer", "unknown"), envelope["occurred_at"], stream_seq, Jsonb(envelope)),
            )

    async def handler(envelope: dict[str, Any], stream_seq: int) -> None:
        await asyncio.to_thread(land, envelope, stream_seq)

    app.state.bus.consume("data-pipeline-service", BRONZE_SUBJECTS, handler)

    interval = int(settings.get("PIPELINE_INTERVAL_SECONDS", "60") or 0)
    if interval > 0:
        app.state.scheduler = asyncio.create_task(schedule(app, interval))


async def on_stop(app: FastAPI) -> None:
    task = getattr(app.state, "scheduler", None)
    if task:
        task.cancel()


async def schedule(app: FastAPI, interval: int) -> None:
    """Runs the pipeline when new events are waiting, or when gold is more than 5 minutes old."""
    log = app.state.log
    while True:
        await asyncio.sleep(interval)
        try:
            status = await asyncio.to_thread(app.state.runner.status)
            last = status["last_success_at"]
            stale = last is None or (datetime.now(timezone.utc) - last).total_seconds() > 300
            if status["pending_events"] > 0 or stale:
                await run_and_announce(app, "schedule", "scheduler")
        except DomainError:
            pass  # a manual run is in progress
        except Exception as exc:
            log.warning("scheduled run could not start", error=str(exc))


async def run_and_announce(app: FastAPI, trigger: str, triggered_by: str, retry_of: str | None = None, simulate_failure: bool = False) -> dict[str, Any]:
    run = await asyncio.to_thread(app.state.runner.execute, trigger, triggered_by, retry_of, simulate_failure)
    settings = app.state.settings
    log = app.state.log
    if run["status"] == "succeeded":
        # Ask analytics-service to load the new gold datasets, authenticating as this service.
        url = settings.get("ANALYTICS_URL")
        if url and app.state.tokens:
            try:
                token = await app.state.tokens.token()
                async with httpx.AsyncClient(timeout=30) as client:
                    response = await client.post(f"{url}/internal/refresh", json={"run_id": str(run["id"])}, headers={"authorization": f"Bearer {token}"})
                run["analytics_refresh"] = "ok" if response.status_code == 200 else f"failed ({response.status_code})"
            except Exception as exc:
                # analytics-service also polls for new gold files, so this only delays the refresh.
                run["analytics_refresh"] = "unreachable"
                log.warning("analytics refresh request failed", error=str(exc))
    await app.state.bus.publish(
        build_envelope(
            "pipeline.run.completed.v1",
            settings.service_name,
            "pipeline_run",
            str(run["id"]),
            PLATFORM_TENANT_ID,
            {
                "run_id": str(run["id"]),
                "pipeline": run["pipeline"],
                "status": run["status"],
                "trigger": run["trigger"],
                "attempt": run["attempt"],
                "events_read": run["events_read"],
                "watermark_to": run["watermark_to"],
            },
            actor={"id": triggered_by, "type": "service" if triggered_by == "scheduler" else "user"},
        )
    )
    return run


app = create_app(
    title="TITAN data-pipeline-service",
    description="Data ingestion, bronze/silver/gold transformation, quality validation, run history and lineage.",
    migrations=Path(__file__).resolve().parent.parent / "migrations",
    on_start=on_start,
    on_stop=on_stop,
)


class RunRequest(BaseModel):
    # Development aid: fail the run after the silver stage to exercise failure tracking and retry.
    simulate_failure: bool = False


@app.get("/status", tags=["pipeline"], summary="Watermark, backlog and last run")
async def status(_: Principal = Depends(require_roles(*READERS))):
    return await asyncio.to_thread(app.state.runner.status)


@app.post("/runs", tags=["pipeline"], summary="Run the pipeline now (on-demand refresh)")
async def trigger_run(body: RunRequest | None = None, user: Principal = Depends(require_roles(*OPERATORS))):
    simulate = bool(body and body.simulate_failure)
    if simulate and (app.state.settings.get("PIPELINE_ALLOW_FAULT_INJECTION", "false").lower() != "true"):
        raise DomainError.forbidden("fault injection is disabled in this environment")
    return await run_and_announce(app, "manual", user.username, simulate_failure=simulate)


@app.post("/runs/{run_id}/retry", tags=["pipeline"], summary="Retry a failed run")
async def retry_run(run_id: str, user: Principal = Depends(require_roles(*OPERATORS))):
    return await run_and_announce(app, "retry", user.username, retry_of=run_id)


@app.get("/runs", tags=["pipeline"], summary="Execution history")
async def list_runs(limit: int = Query(50, ge=1, le=500), _: Principal = Depends(require_roles(*READERS))):
    def query():
        with app.state.db.tx(None, read_only=True) as conn:
            return conn.execute(
                """SELECT id, pipeline, trigger, status, attempt, retry_of, triggered_by, watermark_from, watermark_to, events_read,
                          rows_written, error, started_at, finished_at
                     FROM pipeline_runs ORDER BY started_at DESC LIMIT %s""",
                (limit,),
            ).fetchall()

    return await asyncio.to_thread(query)


@app.get("/runs/{run_id}", tags=["pipeline"], summary="One run with its quality results and lineage")
async def get_run(run_id: str, _: Principal = Depends(require_roles(*READERS))):
    try:
        return await asyncio.to_thread(app.state.runner.describe, run_id)
    except DomainError:
        raise
    except Exception as exc:
        raise DomainError.invalid("malformed run id") from exc


@app.get("/datasets", tags=["catalog"], summary="Dataset catalog with ownership metadata")
async def datasets(_: Principal = Depends(require_roles(*READERS))):
    def query():
        with app.state.db.tx(None, read_only=True) as conn:
            return conn.execute(
                """SELECT name, layer, owner, steward, description, location, primary_key, classification, row_count, last_run_id, updated_at
                     FROM dataset_catalog ORDER BY CASE layer WHEN 'bronze' THEN 1 WHEN 'silver' THEN 2 ELSE 3 END, name"""
            ).fetchall()

    return await asyncio.to_thread(query)


@app.get("/lineage", tags=["catalog"], summary="Source and transformation lineage from the latest successful run")
async def lineage(dataset: str | None = None, _: Principal = Depends(require_roles(*READERS))):
    def query():
        with app.state.db.tx(None, read_only=True) as conn:
            run = conn.execute("SELECT id, finished_at FROM pipeline_runs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1").fetchone()
            if not run:
                return {"run_id": None, "edges": []}
            edges = conn.execute(
                """SELECT target_dataset, source_dataset, transformation FROM lineage_edges
                    WHERE run_id = %s AND (%s::text IS NULL OR target_dataset = %s OR source_dataset = %s)
                    ORDER BY target_dataset, source_dataset""",
                (run["id"], dataset, dataset, dataset),
            ).fetchall()
            return {"run_id": run["id"], "as_of": run["finished_at"], "edges": edges}

    return await asyncio.to_thread(query)
