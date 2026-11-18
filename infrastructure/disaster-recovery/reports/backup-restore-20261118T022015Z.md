# Recovery drill report: backup-restore-20261118T022015Z

| | |
| --- | --- |
| Type | backup-restore |
| Result | **PASSED** |
| Started | 2026-11-18T02:20:15.964Z |
| Finished | 2026-11-18T02:26:14.632Z |
| Topology | single-host laboratory (docker compose); primary and recovery databases are containers on one machine |
| Data | synthetic |

> Demonstrates the recovery procedure. NOT geographic disaster recovery and NOT evidence of production recovery times.

## Summary

Backup backup-20261118T022024Z restored into an isolated instance and verified in 172 s. Recovery point is the start of the backup, 151.9 s before the simulated disaster; the 1 transaction written after the backup was lost, as expected for backup-only recovery.

## Objectives and observed values

| Measure | Target (engineering objective) | Observed in this drill |
| --- | --- | --- |
| RTO | 14400 s | 172 s |
| RPO | 86400 s | 151.9 s |
| Transactions lost | 0 beyond RPO | 1 |

## Steps

| # | Step | Status | Duration | Detail |
| --- | --- | --- | --- | --- |
| 1 | Start recovery tooling | passed | 1.7 s |  |
| 2 | Create representative transactions (before the backup) | passed | 2.3 s | 2 cases (1 approved, 1 in review), 1 asset |
| 3 | Record industry-pack configuration and a maintenance transaction (before the backup) | passed | 0.8 s | facilities@1.0.0, integration-hub@1.0.0, operational-reporting@1.0.0, platform-core@1.1.0, procurement-inventory@1.0.0, public-services@1.0.0, video-monitoring@1.0.0; request MR-2026-000012 approved, work order WO-2026-000007 |
| 4 | Back up all databases | passed | 152.2 s | backup-20261118T022024Z: 21 databases, 335.1 MB in 151.9 s |
| 5 | Create one transaction AFTER the backup (expected to be lost) | passed | 0 s | case APP-2026-000247 |
| 6 | Start an isolated, empty recovery instance | passed | 17.7 s | roles and empty databases present, no tables |
| 7 | Verify backup file checksums | passed | 8.8 s | 21 archives match their SHA-256 |
| 8 | Restore every database from the backup | passed | 148.6 s | 21 databases restored |
| 9 | Verify restored row counts | passed | 11.5 s | 47 tables within the bounds recorded at backup time |
| 10 | Verify recorded transactions in the restored databases | passed | 1.9 s | cases, decisions, pending task, asset, audit records, identity store and RLS present |
| 11 | Verify industry-pack configuration and industry records in the restore | passed | 4.2 s | packs (8), catalogue, history, installed definitions, entitlements, request MR-2026-000012 and work order WO-2026-000007 restored |
| 12 | Detect lost transactions | passed | 0.2 s | 1 transaction created after the backup is absent, as expected (APP-2026-000247) |
| 13 | Run application operations against the restored database | passed | 5.6 s | read restored case, created APP-2026-000247, tenant isolation holds |
| 14 | Confirm the primary was not affected | passed | 0.1 s | the live platform still has every transaction |

## Evidence

```json
{
  "transactions_before_backup": {
    "approved_case": {
      "id": "fcc9f5f5-ad44-4aa1-bfab-9e9715d484b5",
      "reference_no": "APP-2026-000245",
      "created_at": "2026-11-18T02:20:18.352Z"
    },
    "in_review_case": {
      "id": "1b5a2ae5-5867-4583-9b42-a649acfbfdd5",
      "reference_no": "APP-2026-000246",
      "created_at": "2026-11-18T02:20:19.411Z"
    },
    "asset": {
      "id": "a74147ad-8c94-4cc8-a705-d73c8172f41b",
      "code": "DRR-T022015Z"
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
        "pack_id": "integration-hub",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "manufacturing",
        "version": "1.1.0",
        "status": "disabled",
        "config": {}
      },
      {
        "pack_id": "operational-reporting",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "platform-core",
        "version": "1.1.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "procurement-inventory",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "public-services",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      },
      {
        "pack_id": "video-monitoring",
        "version": "1.0.0",
        "status": "active",
        "config": {}
      }
    ],
    "maintenance_request": {
      "id": "8f980d22-52eb-46ab-96e0-8024ac2241c9",
      "reference_no": "MR-2026-000012"
    },
    "work_order": {
      "id": "e8d9aed2-1895-4c8c-bc82-cbbdd8733735",
      "reference_no": "WO-2026-000007"
    }
  },
  "backup": {
    "backup_id": "backup-20261118T022024Z",
    "databases": 21,
    "total_bytes": 351399068,
    "duration_seconds": 151.9,
    "wal_lsn_at_start": "6/9906FFF0",
    "completed_at": "2026-11-18T02:22:55.970Z"
  },
  "transaction_after_backup": {
    "id": "0e5538c4-ea83-41d8-92be-1dcecb6f5982",
    "reference_no": "APP-2026-000247",
    "created_at": "2026-11-18T02:22:56.007Z"
  },
  "simulated_disaster_at": "2026-11-18T02:22:56.007Z",
  "restored_row_counts": {
    "titan_tenant.tenants": 4,
    "titan_tenant.departments": 15,
    "titan_tenant.sites": 4,
    "titan_tenant.pack_catalog": 11,
    "titan_tenant.tenant_packs": 21,
    "titan_tenant.tenant_pack_history": 60,
    "titan_case.cases": 246,
    "titan_case.case_status_history": 926,
    "titan_workflow.workflow_definitions": 41,
    "titan_workflow.workflow_instances": 438,
    "titan_workflow.workflow_tasks": 702,
    "titan_workflow.workflow_decisions": 460,
    "titan_maintenance.request_types": 6,
    "titan_maintenance.maintenance_requests": 87,
    "titan_maintenance.work_orders": 40,
    "titan_maintenance.tenant_entitlements": 4,
    "titan_document.documents": 23,
    "titan_document.document_versions": 23,
    "titan_document.document_links": 6,
    "titan_geo.zones": 4,
    "titan_geo.located_features": 96,
    "titan_geo.incident_locations": 66,
    "titan_procurement.suppliers": 5,
    "titan_procurement.items": 12,
    "titan_procurement.stock_levels": 14,
    "titan_procurement.stock_movements": 27,
    "titan_procurement.purchase_requests": 25,
    "titan_procurement.purchase_orders": 12,
    "titan_procurement.tenant_entitlements": 4,
    "titan_report.report_definitions": 4,
    "titan_report.report_runs": 7,
    "titan_integration.inbound_endpoints": 4,
    "titan_integration.inbound_messages": 16,
    "titan_integration.subscriptions": 6,
    "titan_integration.deliveries": 53,
    "titan_video.cameras": 7,
    "titan_video.view_sessions": 7,
    "titan_video.recordings": 6,
    "titan_video.markers": 2,
    "titan_audit.audit_events": 10642,
    "titan_asset.assets": 98,
    "titan_incident.incidents": 117,
    "titan_device.devices": 90,
    "titan_alert.alert_rules": 19,
    "titan_alert.alerts": 250,
    "titan_notification.notifications": 1447,
    "keycloak.user_entity": 45
  },
  "lost_transactions": [
    "APP-2026-000247"
  ],
  "application_check": {
    "read_restored_case": "ok",
    "post_backup_case": "absent (404)",
    "new_case_created": "APP-2026-000247",
    "tenant_isolation": "ok"
  },
  "timing": {
    "restore_started_at": "2026-11-18T02:23:22.566Z",
    "application_verified_at": "2026-11-18T02:26:14.569Z",
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
