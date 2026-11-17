"""Gold layer: aggregated, reporting-ready datasets, computed with DuckDB SQL
directly over the silver Parquet files.

Every gold dataset is fully recomputed from silver on each run, so the
transformation is deterministic and idempotent, and gold can always be
rebuilt from silver (and silver from bronze) after a loss.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import duckdb

# name -> (description, silver inputs, SQL). `{as_of}` is a TIMESTAMP literal produced by this module.
GOLD: dict[str, tuple[str, list[str], str]] = {
    "approval_turnaround": (
        "Government approval turnaround time per form and outcome",
        ["cases"],
        """
        SELECT tenant_id, form_key, outcome,
               count(*)                                                        AS cases,
               round(avg(epoch(completed_at - submitted_at)) / 3600.0, 4)      AS avg_hours,
               round(median(epoch(completed_at - submitted_at)) / 3600.0, 4)   AS median_hours,
               round(quantile_cont(epoch(completed_at - submitted_at), 0.9) / 3600.0, 4) AS p90_hours,
               min(submitted_at)                                               AS first_submitted_at,
               max(completed_at)                                               AS last_completed_at
          FROM cases
         WHERE submitted_at IS NOT NULL AND completed_at IS NOT NULL AND outcome IN ('approved', 'rejected')
         GROUP BY tenant_id, form_key, outcome
         ORDER BY tenant_id, form_key, outcome
        """,
    ),
    "pending_tasks": (
        "Pending workflow tasks per stage and role, with overdue counts",
        ["workflow_tasks"],
        """
        SELECT tenant_id, subject_type, stage_key, role,
               count(*)                                   AS pending,
               count(*) FILTER (WHERE due_at < {as_of})   AS overdue,
               min(assigned_at)                           AS oldest_assigned_at,
               round(max(epoch({as_of} - assigned_at)) / 3600.0, 4) AS oldest_age_hours
          FROM workflow_tasks
         WHERE status = 'pending'
         GROUP BY tenant_id, subject_type, stage_key, role
         ORDER BY tenant_id, subject_type, stage_key, role
        """,
    ),
    "incidents_by_severity": (
        "Incident counts by severity and lifecycle status",
        ["incidents"],
        """
        SELECT tenant_id, severity,
               CASE WHEN resolved_at IS NOT NULL THEN 'resolved'
                    WHEN acknowledged_at IS NOT NULL THEN 'acknowledged'
                    ELSE 'open' END                                            AS status,
               count(*)                                                        AS incidents,
               round(avg(epoch(acknowledged_at - created_at)), 2)              AS avg_seconds_to_acknowledge
          FROM incidents
         WHERE severity IS NOT NULL
         GROUP BY ALL
         ORDER BY tenant_id, severity, status
        """,
    ),
    "sensor_availability": (
        "Per device: messages received in the trailing hour against the expected reporting rate",
        ["devices", "measurements"],
        """
        WITH recent AS (
          SELECT device_id, count(DISTINCT message_id) AS messages, max(observed_at) AS last_observed_at
            FROM measurements
           WHERE observed_at > {as_of} - INTERVAL 1 HOUR AND observed_at <= {as_of}
           GROUP BY device_id
        )
        SELECT d.tenant_id, d.device_id, d.serial_no, d.name, d.status,
               d.expected_interval_seconds,
               coalesce(r.messages, 0)                                         AS messages_last_hour,
               CAST(floor(3600.0 / d.expected_interval_seconds) AS BIGINT)     AS expected_last_hour,
               round(least(1.0, coalesce(r.messages, 0) / (3600.0 / d.expected_interval_seconds)) * 100, 2) AS availability_pct,
               r.last_observed_at
          FROM devices d LEFT JOIN recent r ON r.device_id = d.device_id
         WHERE d.status <> 'decommissioned' AND d.expected_interval_seconds > 0
         ORDER BY d.tenant_id, d.name
        """,
    ),
    "water_level_trend": (
        "Water level per device in 5-minute buckets over the trailing 24 hours (quality 'ok' readings only)",
        ["measurements"],
        """
        SELECT tenant_id, device_id,
               time_bucket(INTERVAL 5 MINUTE, observed_at) AS bucket,
               round(avg(value), 4)                        AS avg_level,
               min(value)                                  AS min_level,
               max(value)                                  AS max_level,
               count(*)                                    AS samples
          FROM measurements
         WHERE sensor_kind = 'water_level' AND quality = 'ok'
           AND observed_at > {as_of} - INTERVAL 24 HOUR AND observed_at <= {as_of}
         GROUP BY ALL
         ORDER BY tenant_id, device_id, bucket
        """,
    ),
    "asset_maintenance_status": (
        "Assets by lifecycle status and condition, with overdue maintenance counts",
        ["assets"],
        """
        SELECT tenant_id, status, condition,
               count(*)                                                                         AS assets,
               count(*) FILTER (WHERE status <> 'retired' AND next_maintenance_due < {as_of})   AS maintenance_overdue,
               count(*) FILTER (WHERE status <> 'retired' AND next_maintenance_due >= {as_of}
                                  AND next_maintenance_due < {as_of} + INTERVAL 30 DAY)         AS due_within_30_days
          FROM assets
         WHERE status IS NOT NULL
         GROUP BY ALL
         ORDER BY tenant_id, status, condition
        """,
    ),
    # ---- added in TITAN v3: datasets that are not specific to one industry -------------------
    "incidents_by_category": (
        "Incident counts by category, severity and lifecycle status",
        ["incidents"],
        """
        SELECT tenant_id, coalesce(category, 'general') AS category, severity,
               CASE WHEN resolved_at IS NOT NULL THEN 'resolved'
                    WHEN acknowledged_at IS NOT NULL THEN 'acknowledged'
                    ELSE 'open' END                                            AS status,
               count(*)                                                        AS incidents,
               round(avg(epoch(acknowledged_at - created_at)), 2)              AS avg_seconds_to_acknowledge
          FROM incidents
         WHERE severity IS NOT NULL
         GROUP BY ALL
         ORDER BY tenant_id, category, severity, status
        """,
    ),
    "metric_trend": (
        "Any sensor metric per device in 5-minute buckets over the trailing 24 hours (quality 'ok' readings only)",
        ["measurements", "devices"],
        """
        SELECT m.tenant_id, m.device_id, any_value(d.name) AS device_name, any_value(d.device_type) AS device_type,
               m.sensor_kind, any_value(m.unit) AS unit,
               time_bucket(INTERVAL 5 MINUTE, m.observed_at) AS bucket,
               round(avg(m.value), 4)                        AS avg_value,
               min(m.value)                                  AS min_value,
               max(m.value)                                  AS max_value,
               count(*)                                      AS samples
          FROM measurements m LEFT JOIN devices d ON d.device_id = m.device_id
         WHERE m.quality = 'ok'
           AND m.observed_at > {as_of} - INTERVAL 24 HOUR AND m.observed_at <= {as_of}
         GROUP BY m.tenant_id, m.device_id, m.sensor_kind, bucket
         ORDER BY m.tenant_id, m.device_id, m.sensor_kind, bucket
        """,
    ),
    "maintenance_requests": (
        "Maintenance and service requests by industry pack, request type, status and priority",
        ["maintenance_requests"],
        """
        SELECT tenant_id,
               coalesce(pack_id, max(pack_id) OVER (PARTITION BY tenant_id, request_type), 'unknown') AS pack_id,
               request_type, status, priority, requests
          FROM (SELECT tenant_id, pack_id, request_type, status, priority, count(*) AS requests
                  FROM maintenance_requests
                 WHERE status IS NOT NULL AND request_type IS NOT NULL
                 GROUP BY ALL)
         ORDER BY tenant_id, pack_id, request_type, status, priority
        """,
    ),
    "maintenance_work_orders": (
        "Work orders by industry pack, request type, status and priority",
        ["work_orders"],
        """
        SELECT tenant_id,
               coalesce(pack_id, max(pack_id) OVER (PARTITION BY tenant_id, request_type), 'unknown') AS pack_id,
               request_type, status, priority,
               status IN ('open', 'assigned', 'in_progress') AS open,
               work_orders
          FROM (SELECT tenant_id, pack_id, request_type, status, priority, count(*) AS work_orders
                  FROM work_orders
                 WHERE status IS NOT NULL AND request_type IS NOT NULL
                 GROUP BY ALL)
         ORDER BY tenant_id, pack_id, request_type, status, priority
        """,
    ),
    "work_order_turnaround": (
        "Completed work per industry pack and request type: time from request to completion, and time under repair",
        ["work_orders", "maintenance_requests"],
        """
        SELECT w.tenant_id,
               coalesce(any_value(w.pack_id), any_value(r.pack_id), 'unknown')                   AS pack_id,
               w.request_type,
               count(*)                                                                          AS completed,
               round(avg(epoch(w.completed_at - r.submitted_at)) / 3600.0, 4)                    AS avg_request_to_completion_hours,
               round(avg(epoch(w.completed_at - w.started_at)) / 3600.0, 4)                      AS avg_repair_hours,
               round(avg(w.labor_hours), 2)                                                      AS avg_labor_hours,
               max(w.completed_at)                                                               AS last_completed_at
          FROM work_orders w LEFT JOIN maintenance_requests r ON r.request_id = w.request_id
         WHERE w.status = 'completed' AND w.completed_at IS NOT NULL AND w.request_type IS NOT NULL
         GROUP BY w.tenant_id, w.request_type
         ORDER BY w.tenant_id, w.request_type
        """,
    ),
}

# Silver entity tables read by the gold queries.
ENTITY_INPUTS = ("cases", "workflow_tasks", "incidents", "devices", "assets", "maintenance_requests", "work_orders")

# Columns added to silver tables after their first release. A file not yet rewritten by a
# run of the current version is read with these columns as NULL.
ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "incidents": {"category": "VARCHAR", "asset_id": "VARCHAR"},
    "devices": {"device_type": "VARCHAR"},
}


def _literal(path: Path) -> str:
    return "'" + path.as_posix().replace("'", "''") + "'"


def build_gold(silver_dir: Path, gold_dir: Path, as_of: datetime) -> dict[str, int]:
    """Recomputes every gold dataset from silver. Returns row counts per dataset."""
    gold_dir.mkdir(parents=True, exist_ok=True)
    as_of_literal = f"TIMESTAMP '{as_of.strftime('%Y-%m-%d %H:%M:%S')}'"
    counts: dict[str, int] = {}
    con = duckdb.connect(":memory:")
    try:
        for name in ENTITY_INPUTS:
            # union_by_name: a silver file written before a column was added is read with that column null.
            con.execute(f"CREATE VIEW {name}_raw AS SELECT * FROM read_parquet({_literal(silver_dir / f'{name}.parquet')}, union_by_name = true)")
            columns = {row[0] for row in con.execute(f"DESCRIBE {name}_raw").fetchall()}
            extra = ", ".join(f"CAST(NULL AS {kind}) AS {column}" for column, kind in ADDED_COLUMNS.get(name, {}).items() if column not in columns)
            con.execute(f"CREATE VIEW {name} AS SELECT *{', ' + extra if extra else ''} FROM {name}_raw")
        con.execute(
            f"CREATE VIEW measurements AS SELECT * FROM read_parquet({_literal(silver_dir / 'measurements' / '*.parquet')}, union_by_name = true)"
        )
        for name, (_description, _inputs, query) in GOLD.items():
            target = gold_dir / f"{name}.parquet"
            temporary = gold_dir / f".{name}.parquet.tmp"
            con.execute(f"COPY ({query.format(as_of=as_of_literal)}) TO {_literal(temporary)} (FORMAT PARQUET)")
            temporary.replace(target)  # atomic: readers never see a half-written file
            counts[name] = con.execute(f"SELECT count(*) FROM read_parquet({_literal(target)})").fetchone()[0]
    finally:
        con.close()
    return counts
