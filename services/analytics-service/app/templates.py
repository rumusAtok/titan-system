"""Approved analytical query templates.

This is the only way ad-hoc questions (including those asked through the AI
subsystem) reach analytical data: a fixed, reviewed SQL statement per
template, parameters validated against a schema, executed on a read-only
database role inside the caller's tenant. Free-form SQL is never accepted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field


class NoParams(BaseModel):
    model_config = {"extra": "forbid"}


class LimitParams(BaseModel):
    model_config = {"extra": "forbid"}
    limit: int = Field(10, ge=1, le=50)


class PeakParams(BaseModel):
    model_config = {"extra": "forbid"}
    hours: int = Field(24, ge=1, le=24)


class OutcomeParams(BaseModel):
    model_config = {"extra": "forbid"}
    outcome: Literal["approved", "rejected"] = "approved"


class ThresholdParams(BaseModel):
    model_config = {"extra": "forbid"}
    threshold_pct: float = Field(90, ge=0, le=100)


@dataclass(frozen=True)
class QueryTemplate:
    name: str
    description: str
    params: type[BaseModel]
    sql: str
    source_dataset: str


TEMPLATES: dict[str, QueryTemplate] = {
    t.name: t
    for t in [
        QueryTemplate(
            "incidents_by_severity",
            "Incident counts by severity and status",
            NoParams,
            "SELECT severity, status, incidents, avg_seconds_to_acknowledge FROM kpi_incidents_by_severity ORDER BY severity, status",
            "incidents_by_severity",
        ),
        QueryTemplate(
            "workflow_bottlenecks",
            "Workflow stages with the most waiting work, oldest first",
            LimitParams,
            """SELECT subject_type, stage_key, role, pending, overdue, oldest_assigned_at, oldest_age_hours
                 FROM kpi_pending_tasks ORDER BY overdue DESC, oldest_age_hours DESC NULLS LAST LIMIT %(limit)s""",
            "pending_tasks",
        ),
        QueryTemplate(
            "water_level_peaks",
            "Highest water level per sensor within the trailing hours",
            PeakParams,
            """SELECT t.device_id, a.name AS device_name, max(t.max_level) AS peak_level, round(avg(t.avg_level)::numeric, 3) AS mean_level,
                      sum(t.samples) AS samples
                 FROM kpi_water_level_trend t LEFT JOIN kpi_sensor_availability a ON a.device_id = t.device_id
                WHERE t.bucket > now() - make_interval(hours => %(hours)s)
                GROUP BY t.device_id, a.name ORDER BY peak_level DESC""",
            "water_level_trend",
        ),
        QueryTemplate(
            "approval_turnaround_by_form",
            "Approval turnaround per form for one outcome",
            OutcomeParams,
            """SELECT form_key, cases, avg_hours, median_hours, p90_hours FROM kpi_approval_turnaround
                WHERE outcome = %(outcome)s ORDER BY avg_hours DESC NULLS LAST""",
            "approval_turnaround",
        ),
        QueryTemplate(
            "sensors_below_availability",
            "Sensors whose availability in the trailing hour is below a threshold",
            ThresholdParams,
            """SELECT device_id, name, status, messages_last_hour, expected_last_hour, availability_pct, last_observed_at
                 FROM kpi_sensor_availability WHERE availability_pct < %(threshold_pct)s ORDER BY availability_pct""",
            "sensor_availability",
        ),
        QueryTemplate(
            "assets_maintenance_overview",
            "Assets by status and condition with overdue maintenance counts",
            NoParams,
            "SELECT status, condition, assets, maintenance_overdue, due_within_30_days FROM kpi_asset_maintenance_status ORDER BY status, condition",
            "asset_maintenance_status",
        ),
    ]
}


def describe() -> list[dict[str, Any]]:
    return [
        {"name": t.name, "description": t.description, "parameters": t.params.model_json_schema().get("properties", {}), "source_dataset": t.source_dataset}
        for t in TEMPLATES.values()
    ]
