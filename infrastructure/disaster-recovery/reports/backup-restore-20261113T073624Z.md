# Recovery drill report: backup-restore-20261113T073624Z

| | |
| --- | --- |
| Type | backup-restore |
| Result | **PASSED** |
| Started | 2026-11-13T07:36:24.458Z |
| Finished | 2026-11-13T07:37:12.054Z |
| Topology | single-host laboratory (docker compose); primary and recovery databases are containers on one machine |
| Data | synthetic |

> Demonstrates the recovery procedure. NOT geographic disaster recovery and NOT evidence of production recovery times.

## Summary

Backup backup-20261113T073629Z restored into an isolated instance and verified in 13.8 s. Recovery point is the start of the backup, 18.5 s before the simulated disaster; the 1 transaction written after the backup was lost, as expected for backup-only recovery.

## Objectives and observed values

| Measure | Target (engineering objective) | Observed in this drill |
| --- | --- | --- |
| RTO | 14400 s | 13.8 s |
| RPO | 86400 s | 18.5 s |
| Transactions lost | 0 beyond RPO | 1 |

## Steps

| # | Step | Status | Duration | Detail |
| --- | --- | --- | --- | --- |
| 1 | Start recovery tooling | passed | 0.5 s |  |
| 2 | Create representative transactions (before the backup) | passed | 1.1 s | 2 cases (1 approved, 1 in review), 1 asset |
| 3 | Back up all databases | passed | 18.7 s | backup-20261113T073629Z: 14 databases, 1.1 MB in 18.5 s |
| 4 | Create one transaction AFTER the backup (expected to be lost) | passed | 0 s | case APP-2026-000031 |
| 5 | Start an isolated, empty recovery instance | passed | 8 s | roles and empty databases present, no tables |
| 6 | Verify backup file checksums | passed | 2.3 s | 14 archives match their SHA-256 |
| 7 | Restore every database from the backup | passed | 6.8 s | 14 databases restored |
| 8 | Verify restored row counts | passed | 3 s | 15 tables within the bounds recorded at backup time |
| 9 | Verify recorded transactions in the restored databases | passed | 1.6 s | cases, decisions, pending task, asset, audit records, identity store and RLS present |
| 10 | Detect lost transactions | passed | 0.2 s | 1 transaction created after the backup is absent, as expected (APP-2026-000031) |
| 11 | Run application operations against the restored database | passed | 2.2 s | read restored case, created APP-2026-000031, tenant isolation holds |
| 12 | Confirm the primary was not affected | passed | 0 s | the live platform still has every transaction |

## Evidence

```json
{
  "transactions_before_backup": {
    "approved_case": {
      "id": "79395fe2-1514-4c0d-996d-901bb83bdfe8",
      "reference_no": "APP-2026-000029",
      "created_at": "2026-11-13T07:36:25.085Z"
    },
    "in_review_case": {
      "id": "2b02f2c3-18e5-4e18-9919-161b2eda8704",
      "reference_no": "APP-2026-000030",
      "created_at": "2026-11-13T07:36:25.563Z"
    },
    "asset": {
      "id": "21a5f15a-e3ba-4c67-9c98-2f190d1df898",
      "code": "DRR-T073624Z"
    }
  },
  "backup": {
    "backup_id": "backup-20261113T073629Z",
    "databases": 14,
    "total_bytes": 1133600,
    "duration_seconds": 18.5,
    "wal_lsn_at_start": "0/91B3F58",
    "completed_at": "2026-11-13T07:36:47.868Z"
  },
  "transaction_after_backup": {
    "id": "c3d31262-1af7-4dbb-9b19-4c81a474c056",
    "reference_no": "APP-2026-000031",
    "created_at": "2026-11-13T07:36:47.897Z"
  },
  "simulated_disaster_at": "2026-11-13T07:36:47.897Z",
  "restored_row_counts": {
    "titan_tenant.tenants": 2,
    "titan_tenant.departments": 8,
    "titan_case.cases": 30,
    "titan_case.case_status_history": 115,
    "titan_workflow.workflow_instances": 33,
    "titan_workflow.workflow_tasks": 60,
    "titan_workflow.workflow_decisions": 41,
    "titan_audit.audit_events": 580,
    "titan_asset.assets": 17,
    "titan_incident.incidents": 8,
    "titan_device.devices": 12,
    "titan_alert.alert_rules": 8,
    "titan_alert.alerts": 14,
    "titan_notification.notifications": 99,
    "keycloak.user_entity": 23
  },
  "lost_transactions": [
    "APP-2026-000031"
  ],
  "application_check": {
    "read_restored_case": "ok",
    "post_backup_case": "absent (404)",
    "new_case_created": "APP-2026-000031",
    "tenant_isolation": "ok"
  },
  "timing": {
    "restore_started_at": "2026-11-13T07:36:58.214Z",
    "application_verified_at": "2026-11-13T07:37:12.043Z",
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
