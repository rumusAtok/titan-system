# Runbook: backup and restoration

Scope: the local stack and its DR lab. Commands were executed as written (see the
[verification report](../testing/verification-report.md)). The production section at the end is
a plan, not a tested procedure.

## Prerequisites

```powershell
docker compose --profile dr-lab up -d postgres-dr dr-tools
```

`dr-tools` is a container with `pg_dump`, `pg_restore` and `psql` and access to both networks.

## Take a backup

```powershell
npm run dr:backup                      # from the primary
npm run dr:backup -- --from-recovery   # from the standby (no load on the primary)
```

Result in `infrastructure/disaster-recovery/backups/backup-<timestamp>/`:

| File | Content |
| --- | --- |
| `<database>.dump` | Custom-format `pg_dump`, one per database (13 service databases + `keycloak`) |
| `globals.sql` | Roles (with password hashes) |
| `manifest.json` | Sizes, SHA-256 of every file, WAL position, row counts of key tables before and after the dump, verification status |

The directory is git-ignored. **Treat backups as secret material**: they contain all tenant
data and role password hashes.

A backup that has never been restored is not a backup you can rely on. The manifest says
`"verified": null` until a restore drill has passed.

## Verify a backup by restoring it (recommended routine)

```powershell
npm run dr:restore-drill
```

What it does, without touching the primary:

1. Creates known transactions through the API and records them.
2. Takes a backup.
3. Creates one more transaction (which must be absent afterwards).
4. Starts `postgres-restore`: an empty, isolated instance.
5. Checks every file against its checksum.
6. Restores every database with `pg_restore --exit-on-error`.
7. Checks row counts fall within the bounds recorded at backup time.
8. Checks the recorded transactions, the identity store and that row-level security is enabled.
9. Starts a real case-service against the restored database (with an unreachable broker so it
   cannot touch live events) and reads, writes and checks tenant isolation through its API.
10. Writes a report to `infrastructure/disaster-recovery/reports/` and marks the backup verified.

Exit code 0 and `Result: PASSED` mean the backup is restorable. Anything else: read the failed
step in the report.

## Restore for real (primary lost, no usable standby)

Use this only when there is no standby to promote; otherwise follow the
[failover runbook](failover-and-failback.md), which loses far less data.

1. **Stop the application services** so nothing writes during the restore.
   ```powershell
   docker compose --profile core --profile iot --profile analytics --profile ai stop
   ```
2. **Choose the backup**: the newest with `"verified": {"result": "passed"}` in its manifest.
   Everything written after that backup started will be lost; say so before continuing.
3. **Provide an empty database instance.** For the local stack this means removing the primary's
   data volume (destructive; confirm you have the right backup first) and starting it again, so
   the init scripts recreate the roles and empty databases:
   ```powershell
   docker compose rm -sf postgres
   docker volume rm titan_postgres-data
   docker compose up -d postgres
   ```
4. **Verify checksums**, then restore each database:
   ```powershell
   docker compose --profile dr-lab exec dr-tools sh -c "cd /backups/<backup-id> && sha256sum *.dump"
   # compare with manifest.json, then for each database:
   docker compose --profile dr-lab exec dr-tools pg_restore -h postgres -d <database> --exit-on-error --jobs=2 /backups/<backup-id>/<database>.dump
   ```
5. **Start the services** and check health: `./scripts/titan.ps1 up` then `./scripts/titan.ps1 status`.
6. **Validate**: sign in; open a known case; submit and approve a test application.
7. **Reconcile**: the event stream may hold events newer than the restored databases. Consumers
   ignore events they already processed (inbox) and unique constraints stop duplicates; records
   created after the backup are gone and must be re-entered. Rebuild analytics by running the
   pipeline (see [data engineering](../architecture/data-engineering.md#rebuilding-after-a-disaster)).
8. **Rebuild the standby**: `docker compose rm -sf postgres-dr; docker volume rm titan_postgres-dr-data; docker compose --profile dr-lab up -d postgres-dr`.
9. Record what was lost and how long it took.

## Point-in-time recovery (configured, not drilled)

The primary archives WAL (`archive_mode=on`, `archive-wal.sh`) to the `postgres-wal-archive`
volume. Combined with a physical base backup this allows recovery to a chosen moment, for
example just before a destructive mistake. **This path has not been exercised in this
repository.** Until it has, treat PITR as unavailable.

## What is not in these backups

| Not included | Consequence | Mitigation |
| --- | --- | --- |
| The analytical lake | KPIs unavailable until rebuilt | Rebuild from bronze / the stream |
| JetStream stream contents | Events not yet consumed at the time of loss | Outboxes are in the database; consumers are idempotent |
| MQTT broker queue | Readings queued for a stopped telemetry-service | Devices buffer and resend (device dependent) |
| `.env` and secrets | Cannot start without them | Keep in a secret manager, separately from backups |
| Prometheus, Loki, Grafana data | Loss of history | Dashboards and rules are in Git |

## Schedule and retention (to be decided by the operator)

The lab takes backups on demand. A deployment needs a schedule matching its RPO for
backup-only recovery, retention matching its records policy, at least one copy outside the
primary site and account, and a restore drill on a calendar (monthly is a reasonable start).

## Production (planned, not tested)

CloudNativePG performs continuous WAL archiving and scheduled base backups to versioned object
storage (`infrastructure/kubernetes/platform/postgres-cluster.yaml`), with a 30-day retention
policy. Restore is a new `Cluster` with `bootstrap.recovery` from that object store, optionally
with a recovery target time. Velero covers Kubernetes objects and non-database volumes
(`infrastructure/kubernetes/dr/velero-schedules.yaml`). Backup buckets should have object lock
enabled so a compromised primary cannot delete them.
