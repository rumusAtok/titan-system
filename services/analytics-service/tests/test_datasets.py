"""Unit tests for the dataset registry (no database, no network)."""

import pytest

from app import datasets
from app.templates import TEMPLATES


def test_every_dataset_reads_its_own_read_model_and_orders_by_its_own_columns():
    for d in datasets.DATASETS.values():
        assert f"kpi_{d.name}" in d.sql
        assert set(d.filterable) <= set(d.columns), f"{d.name}: a filter column is not returned"
        for part in d.order_by.replace(" DESC", "").split(","):
            assert part.strip() in d.columns, f"{d.name}: orders by an unknown column"


def test_the_original_six_datasets_keep_their_names_and_load_order():
    assert datasets.NAMES[:6] != [], "registry is populated"
    for name in ["approval_turnaround", "pending_tasks", "incidents_by_severity", "sensor_availability", "water_level_trend", "asset_maintenance_status"]:
        assert name in datasets.DATASETS


def test_filters_become_bound_parameters_never_text():
    sql, params = datasets.build_query(datasets.DATASETS["maintenance_work_orders"], {"pack_id": "manufacturing'; DROP TABLE x; --", "open": True}, 50)
    assert "DROP TABLE" not in sql
    assert "d.pack_id = %(f_pack_id)s" in sql and "d.open = %(f_open)s" in sql
    assert params == {"limit": 50, "f_pack_id": "manufacturing'; DROP TABLE x; --", "f_open": True}


def test_a_filter_on_an_undeclared_column_is_refused():
    with pytest.raises(datasets.FilterError):
        datasets.build_query(datasets.DATASETS["maintenance_work_orders"], {"tenant_id": "11111111-1111-4111-8111-111111111111"}, 10)
    with pytest.raises(datasets.FilterError):
        datasets.build_query(datasets.DATASETS["pending_tasks"], {"pending": "1 OR 1=1"}, 10)


def test_filter_values_are_type_checked():
    with pytest.raises(datasets.FilterError):
        datasets.build_query(datasets.DATASETS["maintenance_work_orders"], {"open": "true"}, 10)
    with pytest.raises(datasets.FilterError):
        datasets.build_query(datasets.DATASETS["metric_trend"], {"device_id": "not-a-uuid"}, 10)
    with pytest.raises(datasets.FilterError):
        datasets.build_query(datasets.DATASETS["metric_trend"], {"sensor_kind": True}, 10)
    sql, _ = datasets.build_query(datasets.DATASETS["metric_trend"], {"device_id": "11111111-1111-4111-8111-111111111111"}, 10)
    assert "::uuid" in sql


def test_the_row_limit_is_bounded_by_the_dataset():
    dataset = datasets.DATASETS["pending_tasks"]
    assert datasets.build_query(dataset, {}, 10_000_000)[1]["limit"] == dataset.max_rows
    assert datasets.build_query(dataset, {}, -5)[1]["limit"] == 1


def test_availability_follows_the_tenants_capabilities():
    described = {d["name"]: d for d in datasets.describe(frozenset({"maintenance"}))}
    assert described["pending_tasks"]["available"] is True, "core datasets need no capability"
    assert described["maintenance_work_orders"]["available"] is True
    assert described["metric_trend"]["available"] is False
    assert described["approval_turnaround"]["available"] is False
    assert all(d["available"] for d in datasets.describe(frozenset({"maintenance", "iot", "case_management"})))


def test_every_query_template_reads_a_registered_dataset():
    for template in TEMPLATES.values():
        assert template.source_dataset in datasets.DATASETS
        assert f"kpi_{template.source_dataset}" in template.sql
