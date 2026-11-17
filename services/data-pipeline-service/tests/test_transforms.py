"""Unit tests for the silver and gold transformations (no database, no network)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl

from app import transforms
from app.gold import build_gold

T = "11111111-1111-4111-8111-111111111111"
NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def event(kind: str, payload: dict, occurred: datetime = NOW, tenant: str = T) -> dict:
    return {"event_type": kind, "tenant_id": tenant, "occurred_at": iso(occurred), "payload": payload}


def case_events(case_id: str, hours: float, outcome: str = "approved") -> list[dict]:
    submitted = NOW - timedelta(hours=hours + 1)
    return [
        event(
            "case.submitted.v1",
            {"case_id": case_id, "reference_no": f"APP-{case_id}", "form_key": "building-permit", "workflow_key": "building-permit", "title": "t", "submitted_at": iso(submitted)},
        ),
        event("workflow.case.completed.v1", {"case_id": case_id, "outcome": outcome, "completed_at": iso(submitted + timedelta(hours=hours))}),
    ]


def numbered(events: list[dict], start: int = 1) -> list[tuple[int, dict]]:
    return [(start + i, e) for i, e in enumerate(events)]


def test_entity_merge_combines_events_for_the_same_key():
    changes, malformed = transforms.extract_changes(numbered(case_events("c1", 6)))
    merged = transforms.merge_latest("cases", None, changes["cases"])
    assert malformed == 0
    assert merged.height == 1
    row = merged.row(0, named=True)
    assert row["outcome"] == "approved"
    assert (row["completed_at"] - row["submitted_at"]) == timedelta(hours=6)
    assert row["_seq"] == 2


def test_merge_is_idempotent_when_the_same_events_are_applied_again():
    events = numbered(case_events("c1", 6) + case_events("c2", 30, "rejected"))
    changes, _ = transforms.extract_changes(events)
    once = transforms.merge_latest("cases", None, changes["cases"])
    twice = transforms.merge_latest("cases", once, changes["cases"])
    assert once.equals(twice)


def test_incremental_merge_equals_full_merge():
    first, second = case_events("c1", 6)
    full, _ = transforms.extract_changes(numbered([first, second]))
    part1, _ = transforms.extract_changes([(1, first)])
    part2, _ = transforms.extract_changes([(2, second)])
    incremental = transforms.merge_latest("cases", transforms.merge_latest("cases", None, part1["cases"]), part2["cases"])
    assert incremental.equals(transforms.merge_latest("cases", None, full["cases"]))


def test_later_events_win_and_missing_fields_do_not_erase_values():
    events = numbered(
        [
            event("device.registered.v1", {"device_id": "d1", "serial_no": "S1", "name": "Sensor", "expected_interval_seconds": 5}),
            event("device.status_changed.v1", {"device_id": "d1", "to": "online"}),
            event("device.status_changed.v1", {"device_id": "d1", "to": "offline"}),
        ]
    )
    changes, _ = transforms.extract_changes(events)
    row = transforms.merge_latest("devices", None, changes["devices"]).row(0, named=True)
    assert row["status"] == "offline"
    assert row["serial_no"] == "S1"  # not erased by the status events, which do not carry it
    assert row["expected_interval_seconds"] == 5


def reading_payload(message_id: str, **overrides) -> dict:
    base = {
        "device_id": "d1",
        "sensor_kind": "water_level",
        "value": 2.5,
        "unit": "m",
        "quality": "ok",
        "message_id": message_id,
        "observed_at": iso(NOW),
        "received_at": iso(NOW),
    }
    return {**base, **overrides}


def test_measurements_are_deduplicated_on_their_natural_key():
    changes, _ = transforms.extract_changes(numbered([event("telemetry.measurement.accepted.v1", reading_payload("m1"))] * 3))
    merged = transforms.merge_append("measurements", None, changes["measurements"])
    assert merged.height == 1
    assert transforms.merge_append("measurements", merged, changes["measurements"]).height == 1


def test_malformed_events_are_counted_not_fatal():
    changes, malformed = transforms.extract_changes(numbered([event("case.submitted.v1", {"reference_no": "no case id"}), *case_events("c1", 1)]))
    assert malformed == 1
    assert changes["cases"].height == 2


def test_unknown_event_types_are_ignored():
    changes, malformed = transforms.extract_changes(numbered([event("alert.raised.v1", {"alert_id": "a"})]))
    assert malformed == 0
    assert all(df.height == 0 for df in changes.values())


def test_quality_rules_remove_invalid_rows_and_report_counts():
    payloads = [
        reading_payload("m1"),
        reading_payload("m2", quality="excellent"),
        reading_payload("m3", observed_at=iso(NOW + timedelta(days=30))),
        reading_payload("m4", value=None),
    ]
    changes, _ = transforms.extract_changes(numbered([event("telemetry.measurement.accepted.v1", p) for p in payloads]))
    valid, results = transforms.validate("measurements", changes["measurements"], NOW)
    assert valid["message_id"].to_list() == ["m1"]
    by_rule = {r.rule: r for r in results}
    assert by_rule["quality_in_domain"].failed_rows == 1 and not by_rule["quality_in_domain"].passed
    assert by_rule["observed_not_far_in_future"].failed_rows == 1
    assert by_rule["value_is_finite"].failed_rows == 1
    assert by_rule["tenant_id_not_null"].passed
    assert all(r.total_rows == 4 for r in results)


def test_case_completed_before_submission_fails_quality():
    events = numbered(
        [
            event("case.submitted.v1", {"case_id": "c1", "submitted_at": iso(NOW)}),
            event("workflow.case.completed.v1", {"case_id": "c1", "outcome": "approved", "completed_at": iso(NOW - timedelta(hours=1))}),
        ]
    )
    changes, _ = transforms.extract_changes(events)
    valid, results = transforms.validate("cases", transforms.merge_latest("cases", None, changes["cases"]), NOW)
    assert valid.height == 0
    assert {r.rule: r.failed_rows for r in results}["completed_not_before_submitted"] == 1


def test_validation_of_an_empty_dataset_passes():
    valid, results = transforms.validate("incidents", transforms.frame("incidents", []), NOW)
    assert valid.height == 0
    assert all(r.passed for r in results)


def write_silver(tmp: Path, events: list[dict]) -> None:
    changes, _ = transforms.extract_changes(numbered(events))
    silver = tmp / "silver"
    (silver / "measurements").mkdir(parents=True)
    for name in transforms.ENTITIES:
        transforms.merge_latest(name, None, changes[name]).write_parquet(silver / f"{name}.parquet")
    transforms.merge_append("measurements", None, changes["measurements"]).write_parquet(silver / "measurements" / "date=x.parquet")


def test_gold_kpis_are_computed_from_the_data(tmp_path: Path):
    def reading(i: int, value: float, quality: str = "ok", device: str = "d1") -> dict:
        at = NOW - timedelta(minutes=i)
        return event(
            "telemetry.measurement.accepted.v1",
            reading_payload(f"{device}-{i}", device_id=device, value=value, quality=quality, observed_at=iso(at), received_at=iso(at)),
        )

    def task(task_id: str, due: datetime | None, assigned: datetime) -> dict:
        payload = {"task_id": task_id, "subject_type": "case", "stage_key": "validation", "role": "validation_officer", "due_at": iso(due) if due else None}
        return event("workflow.task.assigned.v1", payload, assigned)

    def asset(asset_id: str, status: str, due: datetime | None) -> dict:
        return event("asset.created.v1", {"asset_id": asset_id, "code": asset_id, "status": status, "condition": "good", "next_maintenance_due": iso(due) if due else None})

    events = [
        *case_events("c1", 2),
        *case_events("c2", 4),
        *case_events("c3", 9),
        *case_events("c4", 5, "rejected"),
        # Still open: must not appear in turnaround.
        event("case.submitted.v1", {"case_id": "c5", "form_key": "building-permit", "submitted_at": iso(NOW)}),
        task("t1", NOW - timedelta(hours=1), NOW - timedelta(hours=5)),
        task("t2", NOW + timedelta(hours=5), NOW - timedelta(hours=1)),
        task("t3", None, NOW - timedelta(hours=2)),
        event("workflow.task.closed.v1", {"task_id": "t3", "status": "completed", "decision": "approve", "assigned_at": iso(NOW - timedelta(hours=2)), "closed_at": iso(NOW)}),
        event("incident.created.v1", {"incident_id": "i1", "severity": "critical", "created_at": iso(NOW - timedelta(minutes=10))}),
        event("incident.acknowledged.v1", {"incident_id": "i1", "acknowledged_at": iso(NOW - timedelta(minutes=8))}),
        event("incident.created.v1", {"incident_id": "i2", "severity": "warning", "created_at": iso(NOW)}),
        event("incident.created.v1", {"incident_id": "i3", "severity": "warning", "created_at": iso(NOW)}),
        event("device.registered.v1", {"device_id": "d1", "serial_no": "S1", "name": "Sensor 1", "expected_interval_seconds": 60}),
        event("device.status_changed.v1", {"device_id": "d1", "to": "online"}),
        event("device.registered.v1", {"device_id": "d2", "serial_no": "S2", "name": "Sensor 2", "expected_interval_seconds": 60}),
        # 30 of the 60 messages expected in the last hour.
        *[reading(i, 2.0 + (i % 5) * 0.1) for i in range(1, 31)],
        # Counts towards availability, excluded from the trend.
        reading(2, 99.0, "out_of_range", "d2"),
        asset("a1", "active", NOW - timedelta(days=2)),
        asset("a2", "active", NOW + timedelta(days=10)),
        asset("a3", "planned", None),
        event("asset.status_changed.v1", {"asset_id": "a3", "to": "active"}),
    ]
    write_silver(tmp_path, events)
    counts = build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))

    def gold(name: str) -> pl.DataFrame:
        return pl.read_parquet(tmp_path / "gold" / f"{name}.parquet")

    turnaround = {r["outcome"]: r for r in gold("approval_turnaround").to_dicts()}
    assert turnaround["approved"]["cases"] == 3
    assert turnaround["approved"]["avg_hours"] == 5.0  # (2 + 4 + 9) / 3
    assert turnaround["approved"]["median_hours"] == 4.0
    assert turnaround["rejected"]["cases"] == 1 and turnaround["rejected"]["avg_hours"] == 5.0

    pending = gold("pending_tasks").to_dicts()
    assert len(pending) == 1
    assert pending[0]["pending"] == 2 and pending[0]["overdue"] == 1  # t3 was closed; t1 is past its due date
    assert pending[0]["oldest_age_hours"] == 5.0

    incidents = {(r["severity"], r["status"]): r for r in gold("incidents_by_severity").to_dicts()}
    assert incidents[("critical", "acknowledged")]["incidents"] == 1
    assert incidents[("critical", "acknowledged")]["avg_seconds_to_acknowledge"] == 120.0
    assert incidents[("warning", "open")]["incidents"] == 2

    availability = {r["device_id"]: r for r in gold("sensor_availability").to_dicts()}
    assert availability["d1"]["expected_last_hour"] == 60
    assert availability["d1"]["messages_last_hour"] == 30
    assert availability["d1"]["availability_pct"] == 50.0
    assert availability["d2"]["messages_last_hour"] == 1

    trend = gold("water_level_trend")
    assert set(trend["device_id"].to_list()) == {"d1"}  # the out_of_range reading of d2 is excluded
    assert trend["samples"].sum() == 30
    assert trend["min_level"].min() >= 2.0 and trend["max_level"].max() <= 2.4

    assets = {r["status"]: r for r in gold("asset_maintenance_status").to_dicts()}
    assert assets["active"]["assets"] == 3
    assert assets["active"]["maintenance_overdue"] == 1
    assert assets["active"]["due_within_30_days"] == 1
    assert counts["approval_turnaround"] == 2


def test_gold_works_on_empty_silver(tmp_path: Path):
    write_silver(tmp_path, [])
    counts = build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    assert set(counts.values()) == {0}


def test_gold_is_deterministic(tmp_path: Path):
    write_silver(tmp_path, case_events("c1", 3) + case_events("c2", 7))
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    first = pl.read_parquet(tmp_path / "gold" / "approval_turnaround.parquet")
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    assert first.equals(pl.read_parquet(tmp_path / "gold" / "approval_turnaround.parquet"))


# --- TITAN v3: datasets shared by every industry -----------------------------------


def maintenance_events(n: str, request_type: str, pack: str, repair_hours: float | None, outcome: str = "approved") -> list[dict]:
    """One request, decided `outcome`; when approved a work order, completed after `repair_hours` if given."""
    submitted = NOW - timedelta(hours=10)
    events = [
        event("maintenance.request.submitted.v1", {"request_id": f"r{n}", "reference_no": f"MR-{n}", "request_type": request_type, "pack_id": pack,
                                                   "priority": "high", "origin_type": "manual", "submitted_at": iso(submitted)}),
        event("maintenance.request.decided.v1", {"request_id": f"r{n}", "request_type": request_type, "pack_id": pack, "outcome": outcome,
                                                 "decided_at": iso(submitted + timedelta(hours=1))}),
    ]
    if outcome != "approved":
        return events
    created = submitted + timedelta(hours=1)
    events.append(event("maintenance.work_order.created.v1", {"work_order_id": f"w{n}", "reference_no": f"WO-{n}", "request_id": f"r{n}", "request_type": request_type,
                                                              "pack_id": pack, "priority": "high", "origin_type": "manual", "created_at": iso(created)}))
    if repair_hours is not None:
        started = created + timedelta(hours=1)
        events += [
            event("maintenance.work_order.assigned.v1", {"work_order_id": f"w{n}", "assignee_id": "u1"}),
            event("maintenance.work_order.started.v1", {"work_order_id": f"w{n}", "started_at": iso(started)}),
            event("maintenance.work_order.completed.v1", {"work_order_id": f"w{n}", "request_type": request_type, "pack_id": pack, "started_at": iso(started),
                                                          "completed_at": iso(started + timedelta(hours=repair_hours)), "labor_hours": repair_hours, "condition_after": "good"}),
        ]
    return events


def test_work_order_status_follows_its_events():
    changes, malformed = transforms.extract_changes(numbered(maintenance_events("1", "equipment-repair", "manufacturing", 2.0)))
    assert malformed == 0
    order = transforms.merge_latest("work_orders", None, changes["work_orders"]).to_dicts()[0]
    assert order["status"] == "completed" and order["pack_id"] == "manufacturing" and order["labor_hours"] == 2.0
    request = transforms.merge_latest("maintenance_requests", None, changes["maintenance_requests"]).to_dicts()[0]
    assert request["status"] == "approved" and request["request_type"] == "equipment-repair"
    valid, results = transforms.validate("work_orders", transforms.merge_latest("work_orders", None, changes["work_orders"]), NOW)
    assert valid.height == 1 and all(r.passed for r in results)


def test_maintenance_gold_keeps_industries_apart(tmp_path: Path):
    events = [
        *maintenance_events("1", "equipment-repair", "manufacturing", 2.0),
        *maintenance_events("2", "equipment-repair", "manufacturing", 4.0),
        *maintenance_events("3", "equipment-repair", "manufacturing", None),  # approved, work order still open
        *maintenance_events("4", "facility-service-request", "facilities", 1.0),
        *maintenance_events("5", "facility-service-request", "facilities", None, "rejected"),
    ]
    write_silver(tmp_path, events)
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))

    def gold(name: str) -> list[dict]:
        return pl.read_parquet(tmp_path / "gold" / f"{name}.parquet").to_dicts()

    orders = {(r["pack_id"], r["status"]): r for r in gold("maintenance_work_orders")}
    assert orders[("manufacturing", "completed")]["work_orders"] == 2 and orders[("manufacturing", "completed")]["open"] is False
    assert orders[("manufacturing", "open")]["work_orders"] == 1 and orders[("manufacturing", "open")]["open"] is True
    assert orders[("facilities", "completed")]["work_orders"] == 1
    assert ("facilities", "open") not in orders

    requests = {(r["pack_id"], r["status"]): r["requests"] for r in gold("maintenance_requests")}
    assert requests == {("manufacturing", "approved"): 3, ("facilities", "approved"): 1, ("facilities", "rejected"): 1}

    turnaround = {r["pack_id"]: r for r in gold("work_order_turnaround")}
    assert turnaround["manufacturing"]["completed"] == 2
    assert turnaround["manufacturing"]["avg_repair_hours"] == 3.0  # (2 + 4) / 2
    assert turnaround["manufacturing"]["avg_request_to_completion_hours"] == 5.0  # 1 h approval + 1 h wait + repair
    assert turnaround["facilities"]["completed"] == 1 and turnaround["facilities"]["avg_repair_hours"] == 1.0


def test_metric_trend_covers_every_sensor_kind(tmp_path: Path):
    def reading(i: int, kind: str, unit: str, value: float, device: str) -> dict:
        at = NOW - timedelta(minutes=i)
        return event("telemetry.measurement.accepted.v1", reading_payload(f"{device}-{kind}-{i}", device_id=device, sensor_kind=kind, unit=unit, value=value, observed_at=iso(at), received_at=iso(at)))

    events = [
        event("device.registered.v1", {"device_id": "m1", "serial_no": "M1", "name": "CNC 1 monitor", "device_type": "machine-condition-monitor", "expected_interval_seconds": 5}),
        event("device.registered.v1", {"device_id": "g1", "serial_no": "G1", "name": "River gauge", "device_type": "flood-monitoring-station", "expected_interval_seconds": 5}),
        *[reading(i, "vibration_rms", "mm/s", 3.0 + i * 0.1, "m1") for i in range(1, 4)],
        *[reading(i, "bearing_temperature", "degC", 60.0, "m1") for i in range(1, 4)],
        *[reading(i, "water_level", "m", 2.0, "g1") for i in range(1, 4)],
        # Flagged by telemetry-service: stored, but never part of a trend.
        event("telemetry.measurement.accepted.v1", reading_payload("bad", device_id="m1", sensor_kind="vibration_rms", unit="mm/s", value=400.0, quality="out_of_range", observed_at=iso(NOW), received_at=iso(NOW))),
    ]
    write_silver(tmp_path, events)
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    trend = pl.read_parquet(tmp_path / "gold" / "metric_trend.parquet")
    summary = trend.group_by("sensor_kind").agg(pl.col("samples").sum(), pl.col("max_value").max(), pl.col("unit").first(), pl.col("device_name").first())
    by_kind = {row["sensor_kind"]: row for row in summary.to_dicts()}
    assert by_kind["vibration_rms"]["samples"] == 3 and by_kind["vibration_rms"]["max_value"] < 4.0, "the out_of_range reading is excluded"
    assert by_kind["vibration_rms"]["unit"] == "mm/s" and by_kind["vibration_rms"]["device_name"] == "CNC 1 monitor"
    assert by_kind["bearing_temperature"]["samples"] == 3 and by_kind["water_level"]["samples"] == 3
    # The original flood dataset is unchanged by the generic one: water level only.
    water = pl.read_parquet(tmp_path / "gold" / "water_level_trend.parquet")
    assert set(water["device_id"].to_list()) == {"g1"}


def test_incidents_by_category_defaults_to_general(tmp_path: Path):
    events = [
        event("incident.created.v1", {"incident_id": "i1", "severity": "warning", "category": "equipment", "created_at": iso(NOW)}),
        event("incident.created.v1", {"incident_id": "i2", "severity": "warning", "category": "equipment", "created_at": iso(NOW)}),
        # An incident recorded before categories existed.
        event("incident.created.v1", {"incident_id": "i3", "severity": "critical", "created_at": iso(NOW)}),
    ]
    write_silver(tmp_path, events)
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    rows = {(r["category"], r["severity"]): r["incidents"] for r in pl.read_parquet(tmp_path / "gold" / "incidents_by_category.parquet").to_dicts()}
    assert rows == {("equipment", "warning"): 2, ("general", "critical"): 1}


def test_silver_written_by_an_earlier_version_is_upgraded_in_place(tmp_path: Path):
    """A stored incidents table without the columns added in v3 still merges and still feeds gold."""
    old_schema = {k: v for k, v in transforms.SCHEMAS["incidents"].items() if k not in ("category", "asset_id")}
    old = pl.DataFrame([{"incident_id": "old1", "tenant_id": T, "severity": "critical", "created_at": transforms.ts(NOW), "_seq": 1}], schema=old_schema, orient="row")

    changes, _ = transforms.extract_changes(numbered([event("incident.created.v1", {"incident_id": "new1", "severity": "warning", "category": "facility", "created_at": iso(NOW)})], start=2))
    merged = transforms.merge_latest("incidents", old, changes["incidents"])
    assert merged.columns == list(transforms.SCHEMAS["incidents"])
    rows = {r["incident_id"]: r for r in merged.to_dicts()}
    assert rows["old1"]["category"] is None and rows["old1"]["severity"] == "critical", "the old row is kept, the new column is empty"
    assert rows["new1"]["category"] == "facility"

    # Gold reads a silver directory in which the incidents file has not been rewritten yet.
    write_silver(tmp_path, [])
    old.write_parquet(tmp_path / "silver" / "incidents.parquet")
    build_gold(tmp_path / "silver", tmp_path / "gold", transforms.ts(NOW))
    by_category = pl.read_parquet(tmp_path / "gold" / "incidents_by_category.parquet").to_dicts()
    assert [(r["category"], r["incidents"]) for r in by_category] == [("general", 1)]
    assert pl.read_parquet(tmp_path / "gold" / "incidents_by_severity.parquet").height == 1
