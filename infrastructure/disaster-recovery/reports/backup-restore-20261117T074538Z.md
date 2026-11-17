# Recovery drill report: backup-restore-20261117T074538Z

| | |
| --- | --- |
| Type | backup-restore |
| Result | **PASSED** |
| Started | 2026-11-17T07:45:38.368Z |
| Finished | 2026-11-17T07:49:12.327Z |
| Topology | single-host laboratory (docker compose); primary and recovery databases are containers on one machine |
| Data | synthetic |

> Demonstrates the recovery procedure. NOT geographic disaster recovery and NOT evidence of production recovery times.

## Summary

Backup backup-20261117T074544Z restored into an isolated instance and verified in 85.8 s. Recovery point is the start of the backup, 102.2 s before the simulated disaster; the 1 transaction written after the backup was lost, as expected for backup-only recovery.

## Objectives and observed values

| Measure | Target (engineering objective) | Observed in this drill |
| --- | --- | --- |
| RTO | 14400 s | 85.8 s |
| RPO | 86400 s | 102.2 s |
| Transactions lost | 0 beyond RPO | 1 |

## Steps

| # | Step | Status | Duration | Detail |
| --- | --- | --- | --- | --- |
| 1 | Start recovery tooling | passed | 0.7 s |  |
| 2 | Create representative transactions (before the backup) | passed | 1.3 s | 2 cases (1 approved, 1 in review), 1 asset |
| 3 | Record industry-pack configuration and a maintenance transaction (before the backup) | passed | 0.7 s | facilities@1.0.0, manufacturing@1.1.0, platform-core@1.0.0; request MR-2026-000008 approved, work order WO-2026-000004 |
| 4 | Back up all databases | passed | 102.5 s | backup-20261117T074544Z: 15 databases, 235.7 MB in 102.2 s |
| 5 | Create one transaction AFTER the backup (expected to be lost) | passed | 0 s | case APP-2026-000193 |
| 6 | Start an isolated, empty recovery instance | passed | 13.2 s | roles and empty databases present, no tables |
| 7 | Verify backup file checksums | passed | 6.7 s | 15 archives match their SHA-256 |
| 8 | Restore every database from the backup | passed | 72.9 s | 15 databases restored |
| 9 | Verify restored row counts | passed | 6.3 s | 24 tables within the bounds recorded at backup time |
| 10 | Verify recorded transactions in the restored databases | passed | 2 s | cases, decisions, pending task, asset, audit records, identity store and RLS present |
| 11 | Verify industry-pack configuration and industry records in the restore | passed | 2.1 s | packs (3), catalogue, history, installed definitions, entitlements, request MR-2026-000008 and work order WO-2026-000004 restored |
| 12 | Detect lost transactions | passed | 0.2 s | 1 transaction created after the backup is absent, as expected (APP-2026-000193) |
| 13 | Run application operations against the restored database | passed | 2.3 s | read restored case, created APP-2026-000193, tenant isolation holds |
| 14 | Confirm the primary was not affected | passed | 0 s | the live platform still has every transaction |

## Evidence

```json
{
  "transactions_before_backup": {
    "approved_case": {
      "id": "81e67daa-d4a7-4e58-8477-ec9a63cf510c",
      "reference_no": "APP-2026-000191",
      "created_at": "2026-11-17T07:45:39.201Z"
    },
    "in_review_case": {
      "id": "73ec685e-3c9d-4e0f-8679-e3a6071a931a",
      "reference_no": "APP-2026-000192",
      "created_at": "2026-11-17T07:45:39.759Z"
    },
    "asset": {
      "id": "e01a8e36-cddc-4f47-8313-f60de42d1f56",
      "code": "DRR-T074538Z"
    }
  },
  "industry_before_backup": {
    "tenant": "33333333-3333-4333-8333-333333333333",
    "packs": [
      {
        "pack_id": "facilities",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "manufacturing",
        "version": "1.1.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "platform-core",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      }
    ],
    "maintenance_request": {
      "id": "d52e3eed-4936-495c-9747-e8d40d80cd4f",
      "reference_no": "MR-2026-000008"
    },
    "work_order": {
      "id": "b2e68270-a59f-402e-aa92-d04f887501d9",
      "reference_no": "WO-2026-000004"
    }
  },
  "backup": {
    "backup_id": "backup-20261117T074544Z",
    "databases": 15,
    "total_bytes": 247150055,
    "duration_seconds": 102.2,
    "wal_lsn_at_start": "4/4222CCB0",
    "completed_at": "2026-11-17T07:47:26.570Z"
  },
  "transaction_after_backup": {
    "id": "40f6b86c-cbf2-4468-a51e-b6177bc84d39",
    "reference_no": "APP-2026-000193",
    "created_at": "2026-11-17T07:47:26.600Z"
  },
  "simulated_disaster_at": "2026-11-17T07:47:26.600Z",
  "restored_row_counts": {
    "titan_tenant.tenants": 4,
    "titan_tenant.departments": 15,
    "titan_tenant.sites": 4,
    "titan_tenant.pack_catalog": 6,
    "titan_tenant.tenant_packs": 12,
    "titan_tenant.tenant_pack_history": 32,
    "titan_case.cases": 192,
    "titan_case.case_status_history": 725,
    "titan_workflow.workflow_definitions": 26,
    "titan_workflow.workflow_instances": 298,
    "titan_workflow.workflow_tasks": 503,
    "titan_workflow.workflow_decisions": 338,
    "titan_maintenance.request_types": 6,
    "titan_maintenance.maintenance_requests": 55,
    "titan_maintenance.work_orders": 25,
    "titan_maintenance.tenant_entitlements": 4,
    "titan_audit.audit_events": 7276,
    "titan_asset.assets": 82,
    "titan_incident.incidents": 86,
    "titan_device.devices": 72,
    "titan_alert.alert_rules": 17,
    "titan_alert.alerts": 166,
    "titan_notification.notifications": 1014,
    "keycloak.user_entity": 36
  },
  "lost_transactions": [
    "APP-2026-000193"
  ],
  "application_check": {
    "read_restored_case": "ok",
    "post_backup_case": "absent (404)",
    "new_case_created": "APP-2026-000193",
    "tenant_isolation": "ok"
  },
  "timing": {
    "restore_started_at": "2026-11-17T07:47:46.491Z",
    "application_verified_at": "2026-11-17T07:49:12.304Z",
    "explanation": "Observed RTO = from the start of the restore to a verified application on the restored database. Observed RPO = time between the START of the backup and the simulated disaster: the worst-case window of writes lost when recovering from this backup alone. In operation this window is the backup interval."
  }
}
```

## Limitations of this drill

- Single host, small synthetic dataset: restore time grows with data volume and is not representative of production.
- The restore target is a container with disposable storage on the same machine as the primary.
- Logical backup only. Point-in-time recovery from the WAL archive is configured (archive_mode=on) but was not exercised by this drill.
- Only case-service was started against the restored data; the other services were verified at database level.
- Object storage, event stream contents and the analytical lake are not part of this backup (see the DR architecture document).
