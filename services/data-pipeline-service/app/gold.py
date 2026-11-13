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
        for name in ("cases", "workflow_tasks", "incidents", "devices", "assets"):
            con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet({_literal(silver_dir / f'{name}.parquet')})")
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
