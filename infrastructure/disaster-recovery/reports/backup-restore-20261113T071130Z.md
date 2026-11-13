# Recovery drill report: backup-restore-20261113T071130Z

| | |
| --- | --- |
| Type | backup-restore |
| Result | **PASSED** |
| Started | 2026-11-13T07:11:30.205Z |
| Finished | 2026-11-13T07:13:16.159Z |
| Topology | single-host laboratory (docker compose); primary and recovery databases are containers on one machine |
| Data | synthetic |

> Demonstrates the recovery procedure. NOT geographic disaster recovery and NOT evidence of production recovery times.

## Summary

Backup backup-20261113T071135Z restored into an isolated instance and verified in 38.5 s. Data written in the 0 s between backup and disaster (1 transaction) was lost, as expected for backup-only recovery.

## Objectives and observed values

| Measure | Target (engineering objective) | Observed in this drill |
| --- | --- | --- |
| RTO | 14400 s | 38.5 s |
| RPO | 86400 s | 0 s |
| Transactions lost | 0 beyond RPO | 1 |

## Steps

| # | Step | Status | Duration | Detail |
| --- | --- | --- | --- | --- |
| 1 | Start recovery tooling | passed | 0.5 s |  |
| 2 | Create representative transactions (before the backup) | passed | 1.5 s | 2 cases (1 approved, 1 in review), 1 asset |
| 3 | Back up all databases | passed | 50.9 s | backup-20261113T071135Z: 14 databases, 110.5 MB in 50.7 s |
| 4 | Create one transaction AFTER the backup (expected to be lost) | passed | 0 s | case APP-2026-000036 |
| 5 | Start an isolated, empty recovery instance | passed | 7.9 s | roles and empty databases present, no tables |
| 6 | Verify backup file checksums | passed | 3.5 s | 14 archives match their SHA-256 |
| 7 | Restore every database from the backup | passed | 31.5 s | 14 databases restored |
| 8 | Verify restored row counts | passed | 3 s | 15 tables within the bounds recorded at backup time |
| 9 | Verify recorded transactions in the restored databases | passed | 1.6 s | cases, decisions, pending task, asset, audit records, identity store and RLS present |
| 10 | Detect lost transactions | passed | 0.2 s | 1 transaction created after the backup is absent, as expected (APP-2026-000036) |
| 11 | Run application operations against the restored database | passed | 2.1 s | read restored case, created APP-2026-000036, tenant isolation holds |
| 12 | Confirm the primary was not affected | passed | 0 s | the live platform still has every transaction |

## Evidence

```json
{
  "transactions_before_backup": {
    "approved_case": {
      "id": "68990e29-6b54-4302-98cd-9631adb75fd2",
      "reference_no": "APP-2026-000034",
      "created_at": "2026-11-13T07:11:30.820Z"
    },
    "in_review_case": {
      "id": "5e4a0764-28e5-4c3a-8f2f-51ccabfd409a",
      "reference_no": "APP-2026-000035",
      "created_at": "2026-11-13T07:11:31.641Z"
    },
    "asset": {
      "id": "584e7276-4144-44af-aad3-34324e9fa3d1",
      "code": "DRR-T071130Z"
    }
  },
  "backup": {
    "backup_id": "backup-20261113T071135Z",
    "databases": 14,
    "total_bytes": 115872588,
    "duration_seconds": 50.7,
    "wal_lsn_at_start": "2/6B366128",
    "completed_at": "2026-11-13T07:12:26.163Z"
  },
  "transaction_after_backup": {
    "id": "9b819703-d422-42e5-af71-0f2fb8c79298",
    "reference_no": "APP-2026-000036",
    "created_at": "2026-11-13T07:12:26.188Z"
  },
  "simulated_disaster_at": "2026-11-13T07:12:26.188Z",
  "restored_row_counts": {
    "titan_tenant.tenants": 2,
    "titan_tenant.departments": 8,
    "titan_case.cases": 35,
    "titan_case.case_status_history": 133,
    "titan_workflow.workflow_instances": 254,
    "titan_workflow.workflow_tasks": 285,
    "titan_workflow.workflow_decisions": 46,
    "titan_audit.audit_events": 5030,
    "titan_asset.assets": 18,
    "titan_incident.incidents": 224,
    "titan_device.devices": 15,
    "titan_alert.alert_rules": 8,
    "titan_alert.alerts": 233,
    "titan_notification.notifications": 780,
    "keycloak.user_entity": 23
  },
  "lost_transactions": [
    "APP-2026-000036"
  ],
  "application_check": {
    "read_restored_case": "ok",
    "post_backup_case": "absent (404)",
    "new_case_created": "APP-2026-000036",
    "tenant_isolation": "ok"
  },
  "timing": {
    "restore_started_at": "2026-11-13T07:12:37.646Z",
    "application_verified_at": "2026-11-13T07:13:16.148Z",
    "explanation": "Observed RTO = from the start of the restore to a verified application on the restored database. Observed RPO = time between completion of the backup and the simulated disaster; everything written in that window is lost when recovering from backup alone."
  }
}
```

## Limitations of this drill

- Single host, small synthetic dataset: restore time grows with data volume and is not representative of production.
- The restore target is a container with disposable storage on the same machine as the primary.
- Logical backup only. Point-in-time recovery from the WAL archive is configured (archive_mode=on) but was not exercised by this drill.
- Only case-service was started against the restored data; the other services were verified at database level.
- Object storage, event stream contents and the analytical lake are not part of this backup (see the DR architecture document).
