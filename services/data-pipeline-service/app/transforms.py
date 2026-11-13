"""Silver layer: validated, standardised, deduplicated entity tables.

Pure functions over Polars frames (no database, no network), so every rule
is unit-testable.

Conventions
- Lake timestamps are UTC, stored WITHOUT a time zone.
- Entity tables are merged with "latest non-null value per key, in bronze
  order". Re-applying the same events therefore changes nothing: a run that
  failed half-way can simply be repeated (idempotent).
- Rows failing a quality rule are left out of silver and counted.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import polars as pl

TS = pl.Datetime("us")

SCHEMAS: dict[str, dict[str, Any]] = {
    "cases": {
        "case_id": pl.String, "tenant_id": pl.String, "reference_no": pl.String, "form_key": pl.String, "workflow_key": pl.String,
        "title": pl.String, "submitted_at": TS, "completed_at": TS, "outcome": pl.String, "_seq": pl.Int64,
    },
    "workflow_tasks": {
        "task_id": pl.String, "tenant_id": pl.String, "instance_id": pl.String, "subject_type": pl.String, "subject_id": pl.String,
        "stage_key": pl.String, "role": pl.String, "assigned_at": TS, "due_at": TS, "closed_at": TS, "status": pl.String,
        "decision": pl.String, "_seq": pl.Int64,
    },
    "incidents": {
        "incident_id": pl.String, "tenant_id": pl.String, "reference_no": pl.String, "title": pl.String, "severity": pl.String,
        "source_type": pl.String, "device_id": pl.String, "created_at": TS, "acknowledged_at": TS, "resolved_at": TS, "_seq": pl.Int64,
    },
    "devices": {
        "device_id": pl.String, "tenant_id": pl.String, "serial_no": pl.String, "name": pl.String,
        "expected_interval_seconds": pl.Int64, "status": pl.String, "status_changed_at": TS, "_seq": pl.Int64,
    },
    "assets": {
        "asset_id": pl.String, "tenant_id": pl.String, "code": pl.String, "name": pl.String, "category": pl.String, "status": pl.String,
        "condition": pl.String, "last_maintained_at": TS, "next_maintenance_due": TS, "_seq": pl.Int64,
    },
    "measurements": {
        "tenant_id": pl.String, "device_id": pl.String, "sensor_kind": pl.String, "value": pl.Float64, "unit": pl.String,
        "quality": pl.String, "message_id": pl.String, "observed_at": TS, "received_at": TS, "_seq": pl.Int64,
    },
}

KEYS = {
    "cases": ["case_id"],
    "workflow_tasks": ["task_id"],
    "incidents": ["incident_id"],
    "devices": ["device_id"],
    "assets": ["asset_id"],
    "measurements": ["device_id", "sensor_kind", "observed_at", "message_id"],
}

# Which bronze event types feed which silver dataset (also recorded as lineage).
SOURCES = {
    "cases": ["case.submitted.v1", "workflow.case.completed.v1"],
    "workflow_tasks": ["workflow.task.assigned.v1", "workflow.task.closed.v1"],
    "incidents": ["incident.created.v1", "incident.acknowledged.v1", "incident.resolved.v1"],
    "devices": ["device.registered.v1", "device.status_changed.v1"],
    "assets": ["asset.created.v1", "asset.status_changed.v1", "asset.maintenance.updated.v1"],
    "measurements": ["telemetry.measurement.accepted.v1"],
}


def ts(value: Any) -> datetime | None:
    """ISO-8601 string -> naive UTC datetime (None stays None)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _changes(event: dict[str, Any], seq: int) -> list[tuple[str, dict[str, Any]]]:
    """Maps one bronze event to zero or more (dataset, partial row) changes."""
    kind = event["event_type"]
    p = event.get("payload") or {}
    tenant = event["tenant_id"]
    base = {"tenant_id": tenant, "_seq": seq}
    match kind:
        case "case.submitted.v1":
            return [("cases", {**base, "case_id": p["case_id"], "reference_no": p.get("reference_no"), "form_key": p.get("form_key"),
                               "workflow_key": p.get("workflow_key"), "title": p.get("title"), "submitted_at": ts(p.get("submitted_at"))})]
        case "workflow.case.completed.v1":
            return [("cases", {**base, "case_id": p["case_id"], "completed_at": ts(p.get("completed_at")), "outcome": p.get("outcome")})]
        case "workflow.task.assigned.v1":
            return [("workflow_tasks", {**base, "task_id": p["task_id"], "instance_id": p.get("instance_id"), "subject_type": p.get("subject_type"),
                                        "subject_id": p.get("subject_id"), "stage_key": p.get("stage_key"), "role": p.get("role"),
                                        "assigned_at": ts(event.get("occurred_at")), "due_at": ts(p.get("due_at")), "status": "pending"})]
        case "workflow.task.closed.v1":
            return [("workflow_tasks", {**base, "task_id": p["task_id"], "instance_id": p.get("instance_id"), "subject_type": p.get("subject_type"),
                                        "subject_id": p.get("subject_id"), "stage_key": p.get("stage_key"), "role": p.get("role"),
                                        "assigned_at": ts(p.get("assigned_at")), "closed_at": ts(p.get("closed_at")), "status": p.get("status"),
                                        "decision": p.get("decision")})]
        case "incident.created.v1":
            return [("incidents", {**base, "incident_id": p["incident_id"], "reference_no": p.get("reference_no"), "title": p.get("title"),
                                   "severity": p.get("severity"), "source_type": p.get("source_type"), "device_id": p.get("device_id"),
                                   "created_at": ts(p.get("created_at"))})]
        case "incident.acknowledged.v1":
            return [("incidents", {**base, "incident_id": p["incident_id"], "acknowledged_at": ts(p.get("acknowledged_at"))})]
        case "incident.resolved.v1":
            return [("incidents", {**base, "incident_id": p["incident_id"], "resolved_at": ts(p.get("resolved_at"))})]
        case "device.registered.v1":
            return [("devices", {**base, "device_id": p["device_id"], "serial_no": p.get("serial_no"), "name": p.get("name"),
                                 "expected_interval_seconds": p.get("expected_interval_seconds"), "status": "registered",
                                 "status_changed_at": ts(event.get("occurred_at"))})]
        case "device.status_changed.v1":
            return [("devices", {**base, "device_id": p["device_id"], "status": p.get("to"), "status_changed_at": ts(event.get("occurred_at"))})]
        case "asset.created.v1":
            return [("assets", {**base, "asset_id": p["asset_id"], "code": p.get("code"), "name": p.get("name"), "category": p.get("category"),
                                "status": p.get("status"), "condition": p.get("condition"), "next_maintenance_due": ts(p.get("next_maintenance_due"))})]
        case "asset.status_changed.v1":
            return [("assets", {**base, "asset_id": p["asset_id"], "status": p.get("to")})]
        case "asset.maintenance.updated.v1":
            return [("assets", {**base, "asset_id": p["asset_id"], "condition": p.get("condition"),
                                "last_maintained_at": ts(p.get("last_maintained_at")), "next_maintenance_due": ts(p.get("next_maintenance_due"))})]
        case "telemetry.measurement.accepted.v1":
            return [("measurements", {**base, "device_id": p["device_id"], "sensor_kind": p.get("sensor_kind"), "value": p.get("value"),
                                      "unit": p.get("unit"), "quality": p.get("quality"), "message_id": p.get("message_id"),
                                      "observed_at": ts(p.get("observed_at")), "received_at": ts(p.get("received_at"))})]
        case _:
            return []


def frame(dataset: str, rows: list[dict[str, Any]]) -> pl.DataFrame:
    """Builds a frame with exactly the dataset's schema (missing fields become null)."""
    schema = SCHEMAS[dataset]
    normalised = [{column: row.get(column) for column in schema} for row in rows]
    return pl.DataFrame(normalised, schema=schema, orient="row") if normalised else pl.DataFrame(schema=schema)


def extract_changes(events: list[tuple[int, dict[str, Any]]]) -> tuple[dict[str, pl.DataFrame], int]:
    """Turns bronze events (seq, envelope) into per-dataset change frames.

    Returns the frames and the number of events that could not be mapped
    because a required field was missing (counted, never fatal).
    """
    rows: dict[str, list[dict[str, Any]]] = {name: [] for name in SCHEMAS}
    malformed = 0
    for seq, event in events:
        try:
            for dataset, row in _changes(event, seq):
                rows[dataset].append(row)
        except (KeyError, ValueError, TypeError):
            malformed += 1
    return {name: frame(name, data) for name, data in rows.items()}, malformed


def merge_latest(dataset: str, existing: pl.DataFrame | None, changes: pl.DataFrame) -> pl.DataFrame:
    """Entity merge: per key, the latest non-null value of every column in bronze order."""
    schema = SCHEMAS[dataset]
    key = KEYS[dataset]
    parts = [f.select(list(schema)).cast(schema) for f in (existing, changes) if f is not None and f.height > 0]
    if not parts:
        return pl.DataFrame(schema=schema)
    combined = pl.concat(parts, how="vertical").sort("_seq")
    merged = combined.group_by(key, maintain_order=True).agg([pl.col(c).drop_nulls().last() for c in schema if c not in key])
    return merged.select(list(schema)).sort(key)


def merge_append(dataset: str, existing: pl.DataFrame | None, changes: pl.DataFrame) -> pl.DataFrame:
    """Fact merge: append, then keep one row per natural key (drops redelivered duplicates)."""
    schema = SCHEMAS[dataset]
    parts = [f.select(list(schema)).cast(schema) for f in (existing, changes) if f is not None and f.height > 0]
    if not parts:
        return pl.DataFrame(schema=schema)
    return pl.concat(parts, how="vertical").sort("_seq").unique(subset=KEYS[dataset], keep="first", maintain_order=True)


# --- data quality ---------------------------------------------------------------


@dataclass(frozen=True)
class QualityResult:
    dataset: str
    rule: str
    passed: bool
    failed_rows: int
    total_rows: int


Rule = tuple[str, Callable[[], pl.Expr]]


def _rules(dataset: str, now: datetime) -> list[Rule]:
    """Each rule is an expression that is TRUE for a valid row."""
    not_null_keys = [(f"{k}_not_null", (lambda k=k: pl.col(k).is_not_null())) for k in KEYS[dataset]]
    common: list[Rule] = [("tenant_id_not_null", lambda: pl.col("tenant_id").is_not_null()), *not_null_keys]
    specific: dict[str, list[Rule]] = {
        "cases": [
            ("outcome_in_domain", lambda: pl.col("outcome").is_null() | pl.col("outcome").is_in(["approved", "rejected", "cancelled"])),
            ("completed_not_before_submitted", lambda: pl.col("completed_at").is_null() | pl.col("submitted_at").is_null() | (pl.col("completed_at") >= pl.col("submitted_at"))),
        ],
        "workflow_tasks": [
            ("status_in_domain", lambda: pl.col("status").is_in(["pending", "completed", "cancelled", "skipped"])),
            ("closed_not_before_assigned", lambda: pl.col("closed_at").is_null() | pl.col("assigned_at").is_null() | (pl.col("closed_at") >= pl.col("assigned_at"))),
        ],
        "incidents": [
            ("severity_in_domain", lambda: pl.col("severity").is_null() | pl.col("severity").is_in(["info", "warning", "critical"])),
            ("acknowledged_not_before_created", lambda: pl.col("acknowledged_at").is_null() | pl.col("created_at").is_null() | (pl.col("acknowledged_at") >= pl.col("created_at"))),
        ],
        "devices": [("expected_interval_positive", lambda: pl.col("expected_interval_seconds").is_null() | (pl.col("expected_interval_seconds") > 0))],
        "assets": [("status_in_domain", lambda: pl.col("status").is_null() | pl.col("status").is_in(["planned", "active", "under_maintenance", "retired"]))],
        "measurements": [
            ("value_is_finite", lambda: pl.col("value").is_not_null() & pl.col("value").is_finite()),
            ("quality_in_domain", lambda: pl.col("quality").is_in(["ok", "out_of_range", "late", "future_timestamp"])),
            ("observed_at_not_null", lambda: pl.col("observed_at").is_not_null()),
            ("observed_not_far_in_future", lambda: pl.col("observed_at").is_null() | (pl.col("observed_at") <= pl.lit(now + timedelta(days=1)))),
        ],
    }
    return common + specific.get(dataset, [])


def validate(dataset: str, df: pl.DataFrame, now: datetime | None = None) -> tuple[pl.DataFrame, list[QualityResult]]:
    """Applies the dataset's quality rules. Returns the valid rows and one result per rule."""
    now = ts(now or datetime.now(timezone.utc))
    total = df.height
    results: list[QualityResult] = []
    valid = pl.lit(True)
    for name, expression in _rules(dataset, now):  # type: ignore[arg-type]
        ok = expression().fill_null(False)
        failed = int(df.select((~ok).sum()).item()) if total else 0
        results.append(QualityResult(dataset, name, failed == 0, failed, total))
        valid = valid & ok
    key = KEYS[dataset]
    duplicates = total - df.unique(subset=key).height if total else 0
    results.append(QualityResult(dataset, "primary_key_unique", duplicates == 0, duplicates, total))
    return (df.filter(valid) if total else df), results


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None
