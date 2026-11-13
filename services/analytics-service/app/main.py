from __future__ import annotations

import asyncio
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import polars as pl
from fastapi import Depends, FastAPI, Query, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ValidationError
from titan_pykit import Database, DomainError, Principal, create_app, require_roles

from .templates import TEMPLATES, describe

STAFF = (
    "validation_officer", "technical_officer", "department_head", "final_approver", "duty_officer", "incident_commander",
    "asset_manager", "iot_operator", "analyst", "auditor", "tenant_admin",
)
EXPORTERS = ("analyst", "tenant_admin")

DATASETS = ["approval_turnaround", "pending_tasks", "incidents_by_severity", "sensor_availability", "water_level_trend", "asset_maintenance_status"]


def _rows_for_load(path: Path) -> list[dict[str, Any]]:
    """Gold Parquet -> JSON rows. Lake timestamps are naive UTC; mark them as UTC for PostgreSQL."""
    df = pl.read_parquet(path)
    temporal = [name for name, dtype in df.schema.items() if dtype == pl.Datetime]
    if temporal:
        df = df.with_columns([pl.col(c).dt.strftime("%Y-%m-%dT%H:%M:%S%.6fZ") for c in temporal])
    return df.to_dicts()


def load_gold(db: Database, gold_dir: Path, run_id: str | None, only_changed: bool) -> dict[str, Any]:
    """Loads gold datasets into the read models. Each dataset is replaced atomically."""
    loaded: dict[str, int] = {}
    skipped: list[str] = []
    with db.tx(None, read_only=True) as conn:
        known = {r["dataset"]: r["source_modified_at"] for r in conn.execute("SELECT dataset, source_modified_at FROM dataset_loads").fetchall()}
    for name in DATASETS:
        path = gold_dir / f"{name}.parquet"
        if not path.exists():
            skipped.append(name)
            continue
        modified = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        if only_changed and name in known and known[name] >= modified:
            continue
        rows = _rows_for_load(path)
        with db.tx(None) as conn:
            loaded[name] = conn.execute("SELECT analytics_load(%s, %s, %s, %s) AS n", (name, Jsonb(rows), run_id, modified)).fetchone()["n"]
    return {"loaded": loaded, "missing": skipped}


async def on_start(app: FastAPI) -> None:
    settings = app.state.settings
    app.state.gold_dir = Path(settings.get("LAKE_DIR", "/lake")) / "gold"
    ro_url = settings.get("DATABASE_READONLY_URL")
    app.state.ro = Database(ro_url, f"{settings.service_name}-readonly", max_size=4) if ro_url else None
    if app.state.ro:
        app.state.ro.open()
    app.state.poller = asyncio.create_task(poll(app, int(settings.get("GOLD_POLL_SECONDS", "30"))))


async def on_stop(app: FastAPI) -> None:
    app.state.poller.cancel()
    if app.state.ro:
        app.state.ro.close()


async def poll(app: FastAPI, interval: int) -> None:
    """Safety net: picks up new gold files even if the pipeline's refresh call was missed."""
    while True:
        try:
            result = await asyncio.to_thread(load_gold, app.state.db, app.state.gold_dir, None, True)
            if result["loaded"]:
                app.state.log.info("read models refreshed from gold (poll)", datasets=list(result["loaded"]))
        except Exception as exc:
            app.state.log.warning("gold poll failed", error=str(exc))
        await asyncio.sleep(interval)


app = create_app(
    title="TITAN analytics-service",
    description="KPIs, aggregated datasets and analytical APIs. Every number is computed from persisted data by the data pipeline.",
    migrations=Path(__file__).resolve().parent.parent / "migrations",
    on_start=on_start,
    on_stop=on_stop,
)


def tenant_query(user: Principal, sql: str, params: tuple | dict | None = None) -> list[dict[str, Any]]:
    with app.state.db.tx(user.tenant_id, read_only=True) as conn:
        return conn.execute(sql, params).fetchall()


def freshness() -> dict[str, Any]:
    with app.state.db.tx(None, read_only=True) as conn:
        loads = conn.execute("SELECT dataset, source_run_id, source_modified_at, loaded_at FROM dataset_loads ORDER BY dataset").fetchall()
    if not loads:
        return {"status": "not_loaded", "computed_at": None, "datasets": []}
    return {"status": "loaded", "computed_at": min(l["source_modified_at"] for l in loads), "source": "data-pipeline-service gold layer", "datasets": loads}


# --- internal --------------------------------------------------------------------


class RefreshRequest(BaseModel):
    run_id: str | None = None


@app.post("/internal/refresh", tags=["internal"], summary="Load the latest gold datasets (service-to-service only)")
async def refresh(body: RefreshRequest | None = None, _: Principal = Depends(require_roles("service"))):
    return await asyncio.to_thread(load_gold, app.state.db, app.state.gold_dir, body.run_id if body else None, False)


# --- KPIs ------------------------------------------------------------------------


@app.get("/kpis/summary", tags=["kpis"], summary="Headline indicators for the executive dashboard")
async def summary(user: Principal = Depends(require_roles(*STAFF))):
    def query():
        with app.state.db.tx(user.tenant_id, read_only=True) as conn:
            one = lambda sql: conn.execute(sql).fetchone()  # noqa: E731
            approvals = one(
                """SELECT COALESCE(sum(cases), 0)::bigint AS completed,
                          COALESCE(sum(cases) FILTER (WHERE outcome = 'approved'), 0)::bigint AS approved,
                          COALESCE(sum(cases) FILTER (WHERE outcome = 'rejected'), 0)::bigint AS rejected,
                          round((sum(avg_hours * cases) / NULLIF(sum(cases), 0))::numeric, 4)::float AS avg_turnaround_hours
                     FROM kpi_approval_turnaround"""
            )
            tasks = one("SELECT COALESCE(sum(pending), 0)::bigint AS pending, COALESCE(sum(overdue), 0)::bigint AS overdue FROM kpi_pending_tasks WHERE subject_type = 'case'")
            incidents = one(
                """SELECT COALESCE(sum(incidents), 0)::bigint AS total,
                          COALESCE(sum(incidents) FILTER (WHERE status = 'open'), 0)::bigint AS open,
                          COALESCE(sum(incidents) FILTER (WHERE status = 'acknowledged'), 0)::bigint AS acknowledged,
                          COALESCE(sum(incidents) FILTER (WHERE status <> 'resolved' AND severity = 'critical'), 0)::bigint AS active_critical
                     FROM kpi_incidents_by_severity"""
            )
            sensors = one(
                """SELECT count(*)::bigint AS devices, count(*) FILTER (WHERE status = 'online')::bigint AS online,
                          round(avg(availability_pct)::numeric, 2)::float AS avg_availability_pct
                     FROM kpi_sensor_availability"""
            )
            assets = one(
                """SELECT COALESCE(sum(assets), 0)::bigint AS total, COALESCE(sum(maintenance_overdue), 0)::bigint AS maintenance_overdue,
                          COALESCE(sum(assets) FILTER (WHERE status = 'under_maintenance'), 0)::bigint AS under_maintenance
                     FROM kpi_asset_maintenance_status"""
            )
        return {"approvals": approvals, "workflow_tasks": tasks, "incidents": incidents, "sensors": sensors, "assets": assets, "freshness": freshness()}

    return await asyncio.to_thread(query)


def _kpi(dataset: str, sql: str):
    async def endpoint(user: Principal = Depends(require_roles(*STAFF))):
        rows = await asyncio.to_thread(tenant_query, user, sql)
        return {"dataset": dataset, "rows": rows, "freshness": await asyncio.to_thread(dataset_freshness, dataset)}

    return endpoint


def dataset_freshness(dataset: str) -> dict[str, Any] | None:
    with app.state.db.tx(None, read_only=True) as conn:
        return conn.execute("SELECT source_run_id, source_modified_at AS computed_at, loaded_at FROM dataset_loads WHERE dataset = %s", (dataset,)).fetchone()


app.get("/kpis/approval-turnaround", tags=["kpis"], summary="Government approval turnaround time")(
    _kpi("approval_turnaround", "SELECT form_key, outcome, cases, avg_hours, median_hours, p90_hours, first_submitted_at, last_completed_at FROM kpi_approval_turnaround ORDER BY form_key, outcome")
)
app.get("/kpis/pending-tasks", tags=["kpis"], summary="Pending workflow tasks")(
    _kpi("pending_tasks", "SELECT subject_type, stage_key, role, pending, overdue, oldest_assigned_at, oldest_age_hours FROM kpi_pending_tasks ORDER BY overdue DESC, pending DESC")
)
app.get("/kpis/incidents-by-severity", tags=["kpis"], summary="Incident counts by severity")(
    _kpi("incidents_by_severity", "SELECT severity, status, incidents, avg_seconds_to_acknowledge FROM kpi_incidents_by_severity ORDER BY severity, status")
)
app.get("/kpis/sensor-availability", tags=["kpis"], summary="Sensor availability over the trailing hour")(
    _kpi("sensor_availability", "SELECT device_id, serial_no, name, status, messages_last_hour, expected_last_hour, availability_pct, last_observed_at FROM kpi_sensor_availability ORDER BY name")
)
app.get("/kpis/asset-maintenance", tags=["kpis"], summary="Asset maintenance status")(
    _kpi("asset_maintenance_status", "SELECT status, condition, assets, maintenance_overdue, due_within_30_days FROM kpi_asset_maintenance_status ORDER BY status, condition")
)


@app.get("/kpis/water-level-trend", tags=["kpis"], summary="Water-level trend (5-minute buckets, trailing 24 hours)")
async def water_level_trend(device_id: str | None = Query(None, pattern=r"^[0-9a-fA-F-]{36}$"), user: Principal = Depends(require_roles(*STAFF))):
    rows = await asyncio.to_thread(
        tenant_query,
        user,
        """SELECT t.device_id, a.name AS device_name, t.bucket, t.avg_level, t.min_level, t.max_level, t.samples
             FROM kpi_water_level_trend t LEFT JOIN kpi_sensor_availability a ON a.device_id = t.device_id
            WHERE (%s::uuid IS NULL OR t.device_id = %s::uuid)
            ORDER BY t.device_id, t.bucket""",
        (device_id, device_id),
    )
    return {"dataset": "water_level_trend", "rows": rows, "freshness": await asyncio.to_thread(dataset_freshness, "water_level_trend")}


@app.get("/datasets", tags=["datasets"], summary="Analytical datasets with freshness and provenance")
async def datasets(user: Principal = Depends(require_roles(*STAFF))):
    def query():
        info = freshness()
        with app.state.db.tx(user.tenant_id, read_only=True) as conn:
            for d in info["datasets"]:
                d["rows_for_tenant"] = conn.execute(f"SELECT count(*) AS n FROM kpi_{d['dataset']}").fetchone()["n"]  # name from our own table
        return info

    return await asyncio.to_thread(query)


# --- export ------------------------------------------------------------------------


@app.get("/export/{dataset}", tags=["datasets"], summary="Export a dataset (the caller's tenant only) as CSV or Parquet")
async def export(dataset: str, format: Literal["csv", "parquet"] = "csv", user: Principal = Depends(require_roles(*EXPORTERS))):
    if dataset not in DATASETS:
        raise DomainError.not_found("dataset")
    rows = await asyncio.to_thread(tenant_query, user, f"SELECT * FROM kpi_{dataset}")  # validated against DATASETS above
    if rows:
        df = pl.DataFrame([{k: (str(v) if k.endswith("_id") else v) for k, v in r.items()} for r in rows], infer_schema_length=None)
    else:
        with app.state.db.tx(None, read_only=True) as conn:
            columns = [c.name for c in conn.execute(f"SELECT * FROM kpi_{dataset} LIMIT 0").description]
        df = pl.DataFrame({c: [] for c in columns})
    buffer = io.BytesIO()
    if format == "csv":
        df.write_csv(buffer)
        media = "text/csv; charset=utf-8"
    else:
        df.write_parquet(buffer)
        media = "application/vnd.apache.parquet"
    headers = {"content-disposition": f'attachment; filename="{dataset}.{format}"', "x-total-count": str(df.height), "cache-control": "private, no-store"}
    return Response(buffer.getvalue(), media_type=media, headers=headers)


# --- approved query templates ----------------------------------------------------


@app.get("/query-templates", tags=["query-templates"], summary="Approved parameterised analytical queries")
async def list_templates(_: Principal = Depends(require_roles(*STAFF))):
    return describe()


class TemplateRun(BaseModel):
    params: dict[str, Any] = {}


@app.post("/query-templates/{name}/run", tags=["query-templates"], summary="Run an approved query template with validated parameters")
async def run_template(name: str, body: TemplateRun | None = None, user: Principal = Depends(require_roles(*STAFF))):
    template = TEMPLATES.get(name)
    if not template:
        raise DomainError.not_found("query template")
    try:
        params = template.params.model_validate((body.params if body else {}) or {})
    except ValidationError as exc:
        raise DomainError.invalid("invalid parameters", json.loads(exc.json(include_url=False, include_context=False))) from exc
    database: Database | None = app.state.ro
    if database is None:
        raise DomainError.unavailable("readonly_unavailable", "the read-only analytical connection is not configured")

    def query():
        # Read-only role + read-only transaction + tenant binding + statement timeout (set on the role).
        with database.tx(user.tenant_id, read_only=True) as conn:
            return conn.execute(template.sql, params.model_dump()).fetchall()

    rows = await asyncio.to_thread(query)
    return {
        "template": name,
        "params": params.model_dump(),
        "rows": rows,
        "row_count": len(rows),
        "source": {"dataset": template.source_dataset, "freshness": await asyncio.to_thread(dataset_freshness, template.source_dataset)},
    }
