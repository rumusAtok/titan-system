"""Registry of approved analytical datasets.

Dashboards (the widgets industry packs define) read data ONLY through this
registry: a widget names a dataset and, optionally, equality filters on the
columns the dataset declares filterable. There is no free-form query.

Each dataset states the capability a tenant needs to read it. `None` means it
belongs to the universal core. Rows are always restricted to the caller's
tenant by row-level security, as for every other read model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

FilterType = Literal["text", "bool", "uuid"]

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@dataclass(frozen=True)
class Dataset:
    name: str
    description: str
    # Capability the tenant must have active; None = universal core.
    capability: str | None
    columns: tuple[str, ...]
    filterable: dict[str, FilterType]
    # A fixed, reviewed SELECT over the read model. Never built from request input.
    sql: str
    order_by: str
    max_rows: int = 2000

    @property
    def table(self) -> str:
        return f"kpi_{self.name}"


class FilterError(ValueError):
    pass


DATASETS: dict[str, Dataset] = {
    d.name: d
    for d in [
        Dataset(
            "approval_turnaround",
            "Approval turnaround per form and outcome",
            "case_management",
            ("form_key", "outcome", "cases", "avg_hours", "median_hours", "p90_hours", "first_submitted_at", "last_completed_at"),
            {"form_key": "text", "outcome": "text"},
            "SELECT form_key, outcome, cases, avg_hours, median_hours, p90_hours, first_submitted_at, last_completed_at FROM kpi_approval_turnaround",
            "form_key, outcome",
        ),
        Dataset(
            "pending_tasks",
            "Pending workflow tasks per subject type, stage and role, with overdue counts",
            None,
            ("subject_type", "stage_key", "role", "pending", "overdue", "oldest_assigned_at", "oldest_age_hours"),
            {"subject_type": "text", "role": "text", "stage_key": "text"},
            "SELECT subject_type, stage_key, role, pending, overdue, oldest_assigned_at, oldest_age_hours FROM kpi_pending_tasks",
            "overdue DESC, pending DESC, subject_type, stage_key",
        ),
        Dataset(
            "incidents_by_severity",
            "Incident counts by severity and lifecycle status",
            None,
            ("severity", "status", "incidents", "avg_seconds_to_acknowledge"),
            {"severity": "text", "status": "text"},
            "SELECT severity, status, incidents, avg_seconds_to_acknowledge FROM kpi_incidents_by_severity",
            "severity, status",
        ),
        Dataset(
            "incidents_by_category",
            "Incident counts by category, severity and lifecycle status",
            None,
            ("category", "severity", "status", "incidents", "avg_seconds_to_acknowledge"),
            {"category": "text", "severity": "text", "status": "text"},
            "SELECT category, severity, status, incidents, avg_seconds_to_acknowledge FROM kpi_incidents_by_category",
            "category, severity, status",
        ),
        Dataset(
            "asset_maintenance_status",
            "Assets by lifecycle status and condition, with overdue maintenance counts",
            None,
            ("status", "condition", "assets", "maintenance_overdue", "due_within_30_days"),
            {"status": "text", "condition": "text"},
            "SELECT status, condition, assets, maintenance_overdue, due_within_30_days FROM kpi_asset_maintenance_status",
            "status, condition",
        ),
        Dataset(
            "sensor_availability",
            "Per device: messages received in the trailing hour against the expected reporting rate",
            "iot",
            ("device_id", "serial_no", "name", "status", "messages_last_hour", "expected_last_hour", "availability_pct", "last_observed_at"),
            {"status": "text", "device_id": "uuid"},
            "SELECT device_id, serial_no, name, status, messages_last_hour, expected_last_hour, availability_pct, last_observed_at FROM kpi_sensor_availability",
            "name",
        ),
        Dataset(
            "water_level_trend",
            "Water level per device in 5-minute buckets over the trailing 24 hours",
            "iot",
            ("device_id", "device_name", "bucket", "avg_level", "min_level", "max_level", "samples"),
            {"device_id": "uuid"},
            """SELECT t.device_id, COALESCE(a.name, t.device_id::text) AS device_name, t.bucket, t.avg_level, t.min_level, t.max_level, t.samples
                 FROM kpi_water_level_trend t LEFT JOIN kpi_sensor_availability a ON a.device_id = t.device_id""",
            "device_id, bucket",
            max_rows=6000,
        ),
        Dataset(
            "metric_trend",
            "Any sensor metric per device in 5-minute buckets over the trailing 24 hours",
            "iot",
            ("device_id", "device_name", "device_type", "sensor_kind", "unit", "bucket", "avg_value", "min_value", "max_value", "samples"),
            {"sensor_kind": "text", "device_id": "uuid", "device_type": "text"},
            """SELECT device_id, COALESCE(device_name, device_id::text) AS device_name, device_type, sensor_kind, unit, bucket, avg_value, min_value, max_value, samples
                 FROM kpi_metric_trend""",
            "sensor_kind, device_id, bucket",
            max_rows=6000,
        ),
        Dataset(
            "maintenance_requests",
            "Maintenance and service requests by industry pack, request type, status and priority",
            "maintenance",
            ("pack_id", "request_type", "status", "priority", "requests"),
            {"pack_id": "text", "request_type": "text", "status": "text", "priority": "text"},
            "SELECT pack_id, request_type, status, priority, requests FROM kpi_maintenance_requests",
            "pack_id, request_type, status, priority",
        ),
        Dataset(
            "maintenance_work_orders",
            "Work orders by industry pack, request type, status and priority",
            "maintenance",
            ("pack_id", "request_type", "status", "priority", "open", "work_orders"),
            {"pack_id": "text", "request_type": "text", "status": "text", "priority": "text", "open": "bool"},
            "SELECT pack_id, request_type, status, priority, open, work_orders FROM kpi_maintenance_work_orders",
            "pack_id, request_type, status, priority",
        ),
        Dataset(
            "work_order_turnaround",
            "Completed work per industry pack and request type: request to completion, and time under repair",
            "maintenance",
            ("pack_id", "request_type", "completed", "avg_request_to_completion_hours", "avg_repair_hours", "avg_labor_hours", "last_completed_at"),
            {"pack_id": "text", "request_type": "text"},
            "SELECT pack_id, request_type, completed, avg_request_to_completion_hours, avg_repair_hours, avg_labor_hours, last_completed_at FROM kpi_work_order_turnaround",
            "pack_id, request_type",
        ),
    ]
}

# Names in the order the loader processes them.
NAMES: list[str] = list(DATASETS)


def build_query(dataset: Dataset, filters: dict[str, Any], limit: int) -> tuple[str, dict[str, Any]]:
    """Builds the parameterised statement for a dataset read.

    Column names come from the registry (a filter on an undeclared column is
    refused); values are always bound parameters, checked against the column's type.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {"limit": max(1, min(int(limit), dataset.max_rows))}
    for column, value in filters.items():
        kind = dataset.filterable.get(column)
        if kind is None:
            raise FilterError(f"'{column}' is not a filterable column of {dataset.name}")
        key = f"f_{column}"
        if kind == "bool":
            if not isinstance(value, bool):
                raise FilterError(f"'{column}' must be true or false")
            clauses.append(f"d.{column} = %({key})s")
        elif kind == "uuid":
            if not isinstance(value, str) or not _UUID.match(value):
                raise FilterError(f"'{column}' must be a UUID")
            clauses.append(f"d.{column} = %({key})s::uuid")
        else:
            if not isinstance(value, str) or len(value) > 200:
                raise FilterError(f"'{column}' must be text")
            clauses.append(f"d.{column} = %({key})s")
        params[key] = value
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return f"SELECT * FROM ({dataset.sql}) d{where} ORDER BY {dataset.order_by} LIMIT %(limit)s", params


def describe(capabilities: frozenset[str] | set[str]) -> list[dict[str, Any]]:
    return [
        {
            "name": d.name,
            "description": d.description,
            "capability": d.capability,
            "available": d.capability is None or d.capability in capabilities,
            "columns": list(d.columns),
            "filterable": d.filterable,
        }
        for d in DATASETS.values()
    ]
